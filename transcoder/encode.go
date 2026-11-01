package transcoder

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/transcoder/db"
)

// Measured 2026-09-30 (60 s of 1080p, VMAF against the source): faster at CRF 23 scores 97.4 at 1080p and 96.4 at
// 720p, encoding 4.4x and 6.5x realtime on 10 cores. veryfast lost 0.7 at the same size; medium gained 0.2 at half the speed.
const (
	x264Preset     = "faster"
	x264CRF        = "23"
	segmentSeconds = 4
	// EncodeThreads is the cores one encode may use, the unit a node's capacity is counted in.
	EncodeThreads     = 4
	tenantEncodeSlots = 8
)

// encodeChunk decodes one time range of the source once and encodes every rung of its lane from it.
// encodeChunk encodes one piece of a lane; report gets how far it has got (0 to 1) as it goes.
func (w *module) encodeChunk(ctx context.Context, ref AssetRef, lane string, chunk int, report func(float64)) error {
	work, p, err := w.loadWork(ctx, ref)
	if err != nil {
		return err
	}
	url, err := w.Store.PresignGet(ctx, work.SourceKey)
	if err != nil {
		return err
	}
	dir, err := os.MkdirTemp("", "chunk")
	if err != nil {
		return err
	}
	defer core.RemoveTemp(dir)

	rungs := p.Lane(lane)
	preset, crf := x264Preset, x264CRF
	if p.Encoder != nil { // the settings the video was planned with, so a retry after a change never mixes two
		preset, crf = p.Encoder.Preset, p.Encoder.CRF
	}
	fps, err := parseFPS(p.FPS)
	if err != nil {
		return err
	}
	start := float64(chunk*p.ChunkFrames) / fps
	filter := "[0:v]"
	if p.Deinterlace {
		filter += "yadif,"
	}
	filter += "fps=" + p.FPS + fmt.Sprintf(",split=%d", len(rungs))
	for i := range rungs {
		filter += fmt.Sprintf("[s%d]", i)
	}
	num, den := parseRate(p.FPS)
	for i, r := range rungs {
		rate := ""
		if r.Half {
			rate = fmt.Sprintf("fps=%d/%d,", num, 2*den)
		}
		filter += fmt.Sprintf(";[s%d]%sscale=%d:%d,setsar=1[o%d]", i, rate, r.Width, r.Height, i)
	}
	args := append([]string{"-ss", strconv.FormatFloat(start, 'f', 6, 64)}, fromUpload(url)...)
	args = append(args, "-filter_complex", filter)
	for i, r := range rungs {
		args = append(args, "-map", fmt.Sprintf("[o%d]", i), "-an")
		frames, gop := p.ChunkFrames, p.GOP
		if r.Half {
			frames, gop = frames/2, gop/2
		}
		if chunk < p.Chunks-1 {
			args = append(args, "-frames:v", strconv.Itoa(frames))
		}
		args = append(args, "-c:v", "libx264", "-threads", strconv.Itoa(max(1, EncodeThreads/len(rungs))), "-preset", preset, "-crf", crf, "-profile:v", "high", "-pix_fmt", "yuv420p",
			"-maxrate", fmt.Sprintf("%dk", r.MaxrateK), "-bufsize", fmt.Sprintf("%dk", 2*r.MaxrateK),
			"-g", strconv.Itoa(gop), "-keyint_min", strconv.Itoa(gop), "-sc_threshold", "0",
			filepath.Join(dir, r.Name+".mp4"))
	}
	// Progress counts the first output's frames.
	if err := FfmpegProgress(ctx, pieceFrames(p, rungs[0], chunk, work.DurationSeconds, fps), report, args...); err != nil {
		return err
	}
	for _, r := range rungs {
		if err := checkPiece(ctx, filepath.Join(dir, r.Name+".mp4"), pieceFrames(p, r, chunk, work.DurationSeconds, fps)); err != nil {
			return fmt.Errorf("%s piece %d: %w", r.Name, chunk, err)
		}
	}
	for _, r := range rungs {
		if err := w.Store.PutFile(ctx, workKey(ref, fmt.Sprintf("%s/%d.mp4", r.Name, chunk)), filepath.Join(dir, r.Name+".mp4")); err != nil {
			return err
		}
	}
	return w.finishTask(ctx, ref, lane, chunk)
}

// pieceFrames is how many frames rung r's piece holds: ChunkFrames, or up to the end of the video for the last one,
// halved for a rung at half the frame rate.
func pieceFrames(p Plan, r Rung, chunk int, durationSeconds, fps float64) int {
	frames := p.ChunkFrames
	if chunk == p.Chunks-1 {
		frames = int(math.Ceil(durationSeconds*fps)) - chunk*p.ChunkFrames
	}
	if r.Half {
		frames /= 2
	}
	return frames
}

// checkPiece refuses an encoded piece with fewer frames than planned. When the source's network read ends early,
// ffmpeg takes it for the end of the video and exits cleanly; uploaded, that piece would fail packaging on every try.
// A few frames short is rounding at the video's end.
func checkPiece(ctx context.Context, path string, want int) error {
	out, err := sandboxed(ctx, "ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets",
		"-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", path).Output()
	if err != nil {
		return fmt.Errorf("counting frames: %w", err)
	}
	got, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		return fmt.Errorf("counting frames: %q", out)
	}
	if got < want-max(3, want/50) {
		return fmt.Errorf("%d frames of %d: the source's read ended early", got, want)
	}
	return nil
}

func parseFPS(s string) (float64, error) {
	num, den := parseRate(s)
	if num == 0 {
		return 0, errors.New("bad frame rate " + s)
	}
	return float64(num) / float64(den), nil
}

// ponytail: stereo AAC only; the multi-channel rendition comes when a customer has 5.1 sources.
func (w *module) encodeAudio(ctx context.Context, ref AssetRef) error {
	work, _, err := w.loadWork(ctx, ref)
	if err != nil {
		return err
	}
	url, err := w.Store.PresignGet(ctx, work.SourceKey)
	if err != nil {
		return err
	}
	dir, err := os.MkdirTemp("", "audio")
	if err != nil {
		return err
	}
	defer core.RemoveTemp(dir)
	out := filepath.Join(dir, "audio.mp4")
	if err := Ffmpeg(ctx, append(fromUpload(url), "-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", "128k", "-ac", "2", out)...); err != nil {
		return err
	}
	if err := w.Store.PutFile(ctx, workKey(ref, "audio.mp4"), out); err != nil {
		return err
	}
	return w.finishTask(ctx, ref, "audio", 0)
}

// finishTask marks one task done and, if it was the last one a stage waits for, queues that stage's packaging.
// The asset row lock serializes finishers, so exactly one of them sees the count reach zero.
func (d *module) finishTask(ctx context.Context, ref AssetRef, lane string, chunk int) error {
	return inTenant(ctx, d.Pool, ref.TenantID, func(q tx) error {
		if _, err := q.LockTasks(ctx, ref.AssetID); err != nil {
			return err
		}
		_, err := q.CompleteEncodeTask(ctx, db.CompleteEncodeTaskParams{AssetID: ref.AssetID, Lane: lane, Chunk: int32(chunk)})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		left, err := q.EncodeTasksLeft(ctx, ref.AssetID)
		if err != nil {
			return err
		}
		var stage string
		switch {
		case left.AllLeft == 0:
			stage = "complete"
		case left.PlayableLeft == 0 && lane != "full":
			stage = "ready"
		default:
			return nil
		}
		_, err = d.River.InsertTx(ctx, q.Tx, PackageArgs{AssetRef: ref, Stage: stage}, nil)
		return err
	})
}
