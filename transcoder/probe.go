package transcoder

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"math"
	"os/exec"
	"strconv"
	"strings"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/ulkanetworks/ulka-vms/transcoder/db"
)

const (
	maxDurationSeconds = 12 * 3600
	maxLongSide        = 4096
)

type probeWorker struct {
	river.WorkerDefaults[ProbeArgs]
	*module
}

func (w *probeWorker) Work(ctx context.Context, job *river.Job[ProbeArgs]) error {
	ref := job.Args.AssetRef
	src, work, code, err := w.probe(ctx, ref)
	if err != nil {
		return w.retryOrFail(ctx, job.JobRow, ref, "processing_failed", err)
	}
	if code != "" {
		return w.fail(ctx, ref, code)
	}
	p := MakePlan(src, work.Preset)
	speed, crf := work.Preset.Quality.x264()
	p.Encoder = &Encoder{Codec: "H.264 (libx264)", Preset: speed, CRF: crf, Profile: "high", SegmentSeconds: segmentSeconds, Encryption: "AES-128, full segment"}
	planJSON, _ := json.Marshal(p)
	key, iv := make([]byte, 16), make([]byte, 16)
	rand.Read(key)
	rand.Read(iv)
	return inTenant(ctx, w.Pool, ref.TenantID, func(q tx) error {
		planned := Planned{Probe: src.Raw, Duration: src.Duration, Width: src.Width, Height: src.Height, Plan: planJSON, Key: key, IV: iv}
		if err := w.hooks.Planned(ctx, q.TenantTx, ref, planned); err != nil {
			return err
		}
		// The tasks are only recorded here; the scheduler hands them to nodes (scheduler.go).
		for _, t := range p.Tasks() {
			if err := q.CreateEncodeTask(ctx, db.CreateEncodeTaskParams{AssetID: ref.AssetID, JobID: ref.JobID, Lane: t.Lane, Chunk: int32(t.Chunk)}); err != nil {
				return err
			}
		}
		_, err := river.ClientFromContext[pgx.Tx](ctx).InsertTx(ctx, q.Tx, StoryboardArgs{AssetRef: ref}, nil)
		return err
	})
}

// probe returns an error code for a source we reject, or an error worth retrying.
func (w *probeWorker) probe(ctx context.Context, ref AssetRef) (Source, Work, string, error) {
	if err := w.hooks.Started(ctx, ref); err != nil {
		return Source{}, Work{}, "", err
	}
	work, err := w.hooks.Work(ctx, ref)
	if err != nil {
		return Source{}, work, "", err
	}
	// A reachable object means any ffprobe failure after this is the file's fault, not the network's.
	if _, err := w.Store.S3.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &w.Store.Bucket, Key: &work.SourceKey}); err != nil {
		return Source{}, work, "", err
	}
	url, err := w.Store.PresignGet(ctx, work.SourceKey)
	if err != nil {
		return Source{}, work, "", err
	}
	src, code, err := probeSource(ctx, url)
	if err != nil || code != "" {
		return src, work, code, err
	}
	err = inTenant(ctx, w.Pool, ref.TenantID, func(q tx) (err error) {
		code, err = w.hooks.Admit(ctx, q.TenantTx, ref, src.Duration)
		return err
	})
	return src, work, code, err
}

func probeSource(ctx context.Context, input string) (Source, string, error) {
	out, err := sandboxed(ctx, "ffprobe", append([]string{"-v", "error", "-print_format", "json", "-show_format", "-show_streams"}, fromUpload(input)...)...).Output()
	if ctx.Err() != nil {
		return Source{}, "", ctx.Err()
	}
	if exitErr := (*exec.ExitError)(nil); errors.As(err, &exitErr) {
		return Source{}, "source_undecodable", nil
	}
	if err != nil {
		return Source{}, "", err
	}
	var p struct {
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
		Streams []struct {
			CodecType    string `json:"codec_type"`
			Width        int    `json:"width"`
			Height       int    `json:"height"`
			AvgFrameRate string `json:"avg_frame_rate"`
			RFrameRate   string `json:"r_frame_rate"`
			FieldOrder   string `json:"field_order"`
			Disposition  struct {
				AttachedPic int `json:"attached_pic"`
			} `json:"disposition"`
			Tags struct {
				Rotate string `json:"rotate"`
			} `json:"tags"`
			SideData []struct {
				Rotation float64 `json:"rotation"`
			} `json:"side_data_list"`
		} `json:"streams"`
	}
	if json.Unmarshal(out, &p) != nil {
		return Source{}, "source_undecodable", nil
	}
	src := Source{Raw: out}
	if src.Duration, err = strconv.ParseFloat(p.Format.Duration, 64); err != nil || src.Duration <= 0 {
		return Source{}, "source_undecodable", nil
	}
	for _, st := range p.Streams {
		if st.CodecType == "audio" {
			src.HasAudio = true
		}
		if st.CodecType != "video" || st.Disposition.AttachedPic == 1 || st.Width == 0 || src.Width != 0 {
			continue
		}
		src.Width, src.Height = st.Width, st.Height
		rotation, _ := strconv.ParseFloat(st.Tags.Rotate, 64)
		for _, sd := range st.SideData {
			if sd.Rotation != 0 {
				rotation = sd.Rotation
			}
		}
		if math.Mod(math.Abs(rotation), 180) == 90 {
			src.Width, src.Height = src.Height, src.Width
		}
		src.FPSNum, src.FPSDen = parseRate(st.AvgFrameRate)
		if src.FPSNum == 0 {
			src.FPSNum, src.FPSDen = parseRate(st.RFrameRate)
		}
		src.Interlaced = st.FieldOrder != "" && st.FieldOrder != "progressive" && st.FieldOrder != "unknown"
	}
	switch {
	case src.Width == 0:
		return Source{}, "no_video_stream", nil
	case src.Duration > maxDurationSeconds:
		return Source{}, "duration_exceeded", nil
	case max(src.Width, src.Height) > maxLongSide:
		return Source{}, "resolution_exceeded", nil
	}
	if src.FPSNum == 0 {
		src.FPSNum, src.FPSDen = 30, 1
	}
	return src, "", nil
}

// parseRate reads ffprobe's "30000/1001"; anything unusable is 0/0.
func parseRate(s string) (int, int) {
	n, d, _ := strings.Cut(s, "/")
	num, err1 := strconv.Atoi(n)
	den, err2 := strconv.Atoi(d)
	if err1 != nil || err2 != nil || num <= 0 || den <= 0 {
		return 0, 0
	}
	return num, den
}
