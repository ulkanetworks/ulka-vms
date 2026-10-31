package transcoder

import (
	"cmp"
	"context"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/riverqueue/river"
	"golang.org/x/sync/errgroup"

	"github.com/ulkanetworks/ulka-vms/core"
)

type packageWorker struct {
	river.WorkerDefaults[PackageArgs]
	*module
}

func (w *packageWorker) Work(ctx context.Context, job *river.Job[PackageArgs]) error {
	a := job.Args
	if err := w.pack(ctx, a); err != nil {
		return w.retryOrFail(ctx, job.JobRow, a.AssetRef, "packaging_failed", err)
	}
	return nil
}

func (w *packageWorker) pack(ctx context.Context, a PackageArgs) error {
	work, p, err := w.loadWork(ctx, a.AssetRef)
	if err != nil {
		return err
	}
	rungs := p.Rungs
	if a.Stage == "ready" {
		rungs = p.Lane("fast")
	}
	dir, err := os.MkdirTemp("", "package")
	if err != nil {
		return err
	}
	defer core.RemoveTemp(dir)
	src, out := filepath.Join(dir, "src"), filepath.Join(dir, "out")
	if err := os.MkdirAll(src, 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		return err
	}

	// Rejoin each rung's chunks without re-encoding.
	for _, r := range rungs {
		var list strings.Builder
		for i := range p.Chunks {
			chunk := filepath.Join(src, fmt.Sprintf("%s_%d.mp4", r.Name, i))
			if err := w.Store.GetFile(ctx, workKey(a.AssetRef, fmt.Sprintf("%s/%d.mp4", r.Name, i)), chunk); err != nil {
				return err
			}
			fmt.Fprintf(&list, "file '%s'\n", chunk)
		}
		listFile := filepath.Join(src, r.Name+".txt")
		if err := os.WriteFile(listFile, []byte(list.String()), 0o644); err != nil {
			return err
		}
		if err := Ffmpeg(ctx, "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", filepath.Join(src, r.Name+".mp4")); err != nil {
			return err
		}
	}

	args := make([]string, 0, len(rungs)+12)
	for _, r := range rungs {
		args = append(args, fmt.Sprintf("in=%s,stream=video,init_segment=%s/init.mp4,segment_template=%s/$Number$.m4s,playlist_name=%s.m3u8",
			filepath.Join(src, r.Name+".mp4"), r.Name, r.Name, r.Name))
	}
	if p.Audio {
		if err := w.Store.GetFile(ctx, workKey(a.AssetRef, "audio.mp4"), filepath.Join(src, "audio.mp4")); err != nil {
			return err
		}
		args = append(args, fmt.Sprintf("in=%s,stream=audio,init_segment=audio/init.mp4,segment_template=audio/$Number$.m4s,playlist_name=audio.m3u8,hls_group_id=audio,hls_name=Audio",
			filepath.Join(src, "audio.mp4")))
	}
	// Shaka packages clear; its aes128 mode points fMP4 fragments at a sample entry the init segment lacks.
	args = append(args,
		"--segment_duration", strconv.Itoa(segmentSeconds),
		"--hls_master_playlist_output", "master.m3u8",
		"--hls_playlist_type", "VOD",
	)
	cmd := exec.CommandContext(ctx, "packager", args...)
	cmd.Dir = out
	if b, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("packager: %w: %s", err, lastLines(string(b), 5))
	}

	names := make([]string, 0, len(rungs)+1)
	for _, r := range rungs {
		names = append(names, r.Name)
	}
	if p.Audio {
		names = append(names, "audio")
	}
	if err := ValidatePackage(out, names, work.DurationSeconds); err != nil {
		return err
	}
	for _, name := range names {
		if err := EncryptRendition(out, name, "/keys/"+a.AssetID.String(), work.Key, work.IV); err != nil {
			return err
		}
	}

	// Segments and rendition playlists first; the master goes last, under the asset lock, so players never see a half-published ladder.
	prefix := Prefix(a.AssetRef)
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(16)
	walkErr := filepath.WalkDir(out, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || d.Name() == "master.m3u8" {
			return err
		}
		rel, err := filepath.Rel(out, path)
		if err != nil {
			return err
		}
		g.Go(func() error { return w.Store.PutFile(gctx, prefix+filepath.ToSlash(rel), path) })
		return nil
	})
	if err := cmp.Or(g.Wait(), walkErr); err != nil {
		return err
	}

	// The owner puts the master in place and marks the video, in one step, so players never see a half-published ladder.
	err = w.hooks.Publish(ctx, a.AssetRef, a.Stage, func(ctx context.Context) error {
		return w.Store.PutFile(ctx, prefix+"master.m3u8", filepath.Join(out, "master.m3u8"))
	})
	if err != nil {
		return err
	}
	if a.Stage == "complete" {
		if err := w.Store.DeletePrefix(ctx, prefix+"work/"); err != nil {
			slog.Warn("could not remove chunk files", "asset", a.AssetID, "err", err)
		}
	}
	return nil
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.Join(lines[max(0, len(lines)-n):], "\n")
}
