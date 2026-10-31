package transcoder

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/ulkanetworks/ulka-vms/core"
)

const (
	storyboardMaxTiles = 100
	storyboardCols     = 10
	storyboardTileW    = 160
)

type storyboardWorker struct {
	river.WorkerDefaults[StoryboardArgs]
	*module
}

// Work tiles up to 100 frames sampled evenly across the source and indexes them in WebVTT.
func (w *storyboardWorker) Work(ctx context.Context, job *river.Job[StoryboardArgs]) error {
	ref := job.Args.AssetRef
	work, p, err := w.loadWork(ctx, ref)
	if errors.Is(err, pgx.ErrNoRows) {
		return river.JobCancel(err)
	}
	if err != nil {
		return err
	}
	url, err := w.Store.PresignGet(ctx, work.SourceKey)
	if err != nil {
		return err
	}
	dir, err := os.MkdirTemp("", "storyboard")
	if err != nil {
		return err
	}
	defer core.RemoveTemp(dir)

	duration := work.DurationSeconds
	interval := max(1, duration/storyboardMaxTiles)
	n := int(math.Ceil(duration / interval))
	cols := min(n, storyboardCols)
	rows := (n + cols - 1) / cols
	top := p.Rungs[0]
	tileH := Even(float64(storyboardTileW) * float64(top.Height) / float64(top.Width))
	sprite := filepath.Join(dir, "storyboard.jpg")
	// Every frame is decoded: keyframes alone are too sparse (23 in a 190 s sample), repeating tiles and emptying short clips.
	if err := Ffmpeg(ctx, append(fromUpload(url),
		"-vf", fmt.Sprintf("fps=1/%f,scale=%d:%d,tile=%dx%d", interval, storyboardTileW, tileH, cols, rows),
		"-frames:v", "1", "-q:v", "5", sprite)...); err != nil {
		return err
	}
	var vtt strings.Builder
	vtt.WriteString("WEBVTT\n")
	for i := range n {
		fmt.Fprintf(&vtt, "\n%s --> %s\nstoryboard.jpg#xywh=%d,%d,%d,%d\n", vttTime(float64(i)*interval), vttTime(min(float64(i+1)*interval, duration)),
			(i%cols)*storyboardTileW, (i/cols)*tileH, storyboardTileW, tileH)
	}
	vttFile := filepath.Join(dir, "storyboard.vtt")
	if err := os.WriteFile(vttFile, []byte(vtt.String()), 0o644); err != nil {
		return err
	}
	prefix := ref.TenantID.String() + "/" + ref.AssetID.String() + "/images/"
	if err := w.Store.PutFile(ctx, prefix+"storyboard.jpg", sprite); err != nil {
		return err
	}
	return w.Store.PutFile(ctx, prefix+"storyboard.vtt", vttFile)
}

func vttTime(s float64) string {
	ms := int(math.Round(s * 1000))
	return fmt.Sprintf("%02d:%02d:%02d.%03d", ms/3600000, ms/60000%60, ms/1000%60, ms%1000)
}
