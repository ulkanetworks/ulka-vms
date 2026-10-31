package video

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/transcoder"
)

const posterAt = 0.1 // fraction of the duration

// image serves the poster and thumbnails (.webp or .jpg), and the storyboard sprite and its index, whose relative
// links to the sprite get the viewer's signature.
func (s *module) image(w http.ResponseWriter, r *http.Request, p playback, file string) {
	var body []byte
	var err error
	switch file {
	case "storyboard.jpg":
		body, err = s.Store.ReadObject(r.Context(), p.prefix()+"images/storyboard.jpg")
	case "storyboard.vtt":
		body, err = s.Store.ReadObject(r.Context(), p.prefix()+"images/storyboard.vtt")
		if p.token != "" {
			body = []byte(strings.ReplaceAll(string(body), "\nstoryboard.jpg#", "\n"+strings.TrimSuffix(p.link("storyboard.jpg#"), "#")+"#"))
		}
	default:
		name, ext, _ := strings.Cut(file, ".")
		if (name != "thumbnail" && name != "poster") || (ext != "webp" && ext != "jpg") {
			core.WriteError(w, http.StatusNotFound, "not_found")
			return
		}
		t := p.duration * posterAt
		if name == "poster" && p.posterTime.Valid {
			t = p.posterTime.Float64
		}
		if v := r.URL.Query().Get("time"); name == "thumbnail" && v != "" {
			if t, err = strconv.ParseFloat(v, 64); err != nil || t < 0 || t > p.duration || math.IsNaN(t) {
				core.WriteError(w, http.StatusBadRequest, "invalid_time")
				return
			}
		}
		width := 0
		if v := r.URL.Query().Get("width"); v != "" {
			if width, err = strconv.Atoi(v); err != nil || width < 16 || width > 1920 {
				core.WriteError(w, http.StatusBadRequest, "invalid_width")
				return
			}
		}
		if name == "poster" && p.posterUploaded.Valid {
			body, err = s.uploadedPoster(r.Context(), p, width, ext)
		} else {
			body, err = s.thumbnail(r.Context(), p, t, width, ext)
		}
	}
	if nsk := (*types.NoSuchKey)(nil); errors.As(err, &nsk) {
		core.WriteError(w, http.StatusNotFound, "not_found") // storyboard not made yet
		return
	}
	if err != nil {
		core.InternalError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", map[string]string{".jpg": "image/jpeg", ".webp": "image/webp", ".vtt": "text/vtt"}[filepath.Ext(file)])
	// The cover can be changed, so it is kept five minutes; frames and the storyboard never change.
	age := "86400"
	if strings.HasPrefix(file, "poster.") {
		age = "300"
	}
	if p.policy == "public" {
		w.Header().Set("Cache-Control", "public, max-age="+age)
	} else {
		w.Header().Set("Cache-Control", "private, max-age="+age)
	}
	w.Write(body)
}

// thumbnail cuts one frame from the smallest published rendition at least width wide, decrypting just the segment
// that holds time t. Renditions outlive the original, so this keeps working after retention deletes it.
func (s *module) thumbnail(ctx context.Context, p playback, t float64, width int, ext string) ([]byte, error) {
	rungs := p.plan.Rungs
	if p.status != "complete" {
		rungs = p.plan.Lane("fast")
	}
	rung := rungs[0] // largest first
	for _, r := range rungs {
		if width > 0 && r.Width >= width {
			rung = r
		}
	}
	if width == 0 || width > rung.Width {
		width = rung.Width
	}
	cacheKey := fmt.Sprintf("%simages/thumbs/%d_%d.%s", p.prefix(), int(math.Round(t*10))*100, width, ext)
	if b, err := s.Store.ReadObject(ctx, cacheKey); err == nil {
		return b, nil
	}

	playlist, err := s.Store.ReadObject(ctx, p.prefix()+rung.Name+".m3u8")
	if err != nil {
		return nil, err
	}
	segment, offset, iv, err := transcoder.SegmentAt(playlist, t)
	if err != nil {
		return nil, err
	}
	init, err := s.Store.ReadObject(ctx, p.prefix()+rung.Name+"/init.mp4")
	if err != nil {
		return nil, err
	}
	enc, err := s.Store.ReadObject(ctx, p.prefix()+segment)
	if err != nil {
		return nil, err
	}
	clear, err := transcoder.DecryptSegment(enc, p.key, iv)
	if err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp("", "thumb")
	if err != nil {
		return nil, err
	}
	defer core.RemoveTemp(dir)
	in, frame := filepath.Join(dir, "in.mp4"), filepath.Join(dir, "frame."+map[string]string{"jpg": "jpg", "webp": "png"}[ext])
	if err := os.WriteFile(in, append(init, clear...), 0o644); err != nil {
		return nil, err
	}
	if err := transcoder.Ffmpeg(ctx, "-ss", strconv.FormatFloat(offset, 'f', 3, 64), "-i", in, "-frames:v", "1", "-vf", fmt.Sprintf("scale=%d:-2", width), "-q:v", "3", frame); err != nil {
		return nil, err
	}
	if ext == "webp" {
		out := filepath.Join(dir, "frame.webp")
		if b, err := exec.CommandContext(ctx, "cwebp", "-quiet", "-q", "80", frame, "-o", out).CombinedOutput(); err != nil {
			return nil, fmt.Errorf("cwebp: %w: %s", err, b)
		}
		frame = out
	}
	b, err := os.ReadFile(frame)
	if err != nil {
		return nil, err
	}
	_, err = s.Store.S3.PutObject(ctx, &s3.PutObjectInput{Bucket: &s.Store.Bucket, Key: &cacheKey, Body: bytes.NewReader(b)})
	return b, err
}
