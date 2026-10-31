package video

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/transcoder"
)

// ImageConvert redraws a customer's picture as ext ("jpg" or "webp"), at most width wide (0 keeps its size), at
// quality (0 for the default). A file that isn't a picture is errNotAnImage; one too big is errImageTooLarge.
type ImageConvert func(ctx context.Context, body []byte, width, quality int, ext string) ([]byte, error)

const (
	maxCoverBytes  = 25 << 20
	maxCoverPixels = 100_000_000
)

var (
	errImageTooLarge = core.APIError{Status: http.StatusUnprocessableEntity, Code: "image_too_large"}
	errNotAnImage    = core.APIError{Status: http.StatusUnprocessableEntity, Code: "not_an_image"}
)

// imageDemuxer names ffmpeg's reader for a JPEG, PNG, GIF or WebP by its first bytes, or "" for anything else.
// Naming it, never letting ffmpeg guess, keeps a crafted file from being read as a playlist or a file pattern.
func imageDemuxer(b []byte) string {
	switch {
	case bytes.HasPrefix(b, []byte{0xFF, 0xD8, 0xFF}):
		return "jpeg_pipe"
	case bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")):
		return "png_pipe"
	case bytes.HasPrefix(b, []byte("GIF8")):
		return "gif"
	case len(b) >= 12 && bytes.HasPrefix(b, []byte("RIFF")) && string(b[8:12]) == "WEBP":
		return "webp_pipe"
	}
	return ""
}

// ffmpegConvert is ImageConvert through the sandboxed ffmpeg that cuts video frames, and cwebp for WebP.
func ffmpegConvert(ctx context.Context, body []byte, width, quality int, ext string) ([]byte, error) {
	if len(body) > maxCoverBytes {
		return nil, errImageTooLarge
	}
	demuxer := imageDemuxer(body)
	if demuxer == "" {
		return nil, errNotAnImage
	}
	dir, err := os.MkdirTemp("", "cover")
	if err != nil {
		return nil, err
	}
	defer core.RemoveTemp(dir)
	in, frame := filepath.Join(dir, "in"), filepath.Join(dir, "frame."+map[string]string{"jpg": "jpg", "webp": "png"}[ext])
	if err := os.WriteFile(in, body, 0o600); err != nil {
		return nil, err
	}
	args := []string{"-protocol_whitelist", "file", "-max_pixels", strconv.Itoa(maxCoverPixels), "-f", demuxer, "-i", in, "-frames:v", "1"}
	if width > 0 {
		args = append(args, "-vf", fmt.Sprintf("scale='min(iw,%d)':-2", width))
	}
	if err := transcoder.Ffmpeg(ctx, append(args, "-q:v", "3", frame)...); err != nil {
		slog.WarnContext(ctx, "could not read an uploaded cover", "demuxer", demuxer, "err", err)
		return nil, errNotAnImage
	}
	if ext == "webp" {
		if quality == 0 {
			quality = 80
		}
		out := filepath.Join(dir, "frame.webp")
		if b, err := exec.CommandContext(ctx, "cwebp", "-quiet", "-q", strconv.Itoa(quality), frame, "-o", out).CombinedOutput(); err != nil {
			return nil, fmt.Errorf("cwebp: %w: %s", err, b)
		}
		frame = out
	}
	return os.ReadFile(frame)
}
