package transcoder

import (
	"bufio"
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ValidatePackage checks every playlist parses, ends, lists only segments that exist, and adds up to the source's duration.
func ValidatePackage(dir string, names []string, wantSeconds float64) error {
	master, err := os.ReadFile(filepath.Join(dir, "master.m3u8"))
	if err != nil {
		return err
	}
	for _, name := range names {
		if !strings.Contains(string(master), name+".m3u8") {
			return fmt.Errorf("master playlist is missing %s", name)
		}
		f, err := os.Open(filepath.Join(dir, name+".m3u8"))
		if err != nil {
			return err
		}
		var total float64
		var segments int
		var ended bool
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			switch {
			case strings.HasPrefix(line, "#EXTINF:"):
				d, err := strconv.ParseFloat(strings.TrimSuffix(strings.TrimPrefix(line, "#EXTINF:"), ","), 64)
				if err != nil {
					f.Close()
					return fmt.Errorf("%s: bad %q", name, line)
				}
				total += d
			case line == "#EXT-X-ENDLIST":
				ended = true
			case line != "" && !strings.HasPrefix(line, "#"):
				if st, err := os.Stat(filepath.Join(dir, line)); err != nil || st.Size() == 0 {
					f.Close()
					return fmt.Errorf("%s: segment %s missing or empty", name, line)
				}
				segments++
			}
		}
		f.Close()
		if err := sc.Err(); err != nil {
			return err
		}
		if !ended || segments == 0 {
			return fmt.Errorf("%s: playlist incomplete", name)
		}
		if math.Abs(total-wantSeconds) > max(1, wantSeconds*0.01) {
			return fmt.Errorf("%s: %.2fs of media, source is %.2fs", name, total, wantSeconds)
		}
	}
	return nil
}

// EncryptRendition applies HLS full-segment AES-128: each segment CBC-encrypted with PKCS#7 padding, the init segment left clear.
// A fixed IV per asset keeps output identical across re-packaging, so republished segments never change under a player.
func EncryptRendition(dir, name, keyURI string, key, iv []byte) error {
	playlist := filepath.Join(dir, name+".m3u8")
	b, err := os.ReadFile(playlist)
	if err != nil {
		return err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return err
	}
	var out strings.Builder
	for _, line := range strings.SplitAfter(string(b), "\n") {
		out.WriteString(line)
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "#EXT-X-MAP:") {
			fmt.Fprintf(&out, "#EXT-X-KEY:METHOD=AES-128,URI=\"%s\",IV=0x%s\n", keyURI, hex.EncodeToString(iv))
		}
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		seg := filepath.Join(dir, line)
		data, err := os.ReadFile(seg)
		if err != nil {
			return err
		}
		pad := aes.BlockSize - len(data)%aes.BlockSize
		data = append(data, bytes.Repeat([]byte{byte(pad)}, pad)...)
		cipher.NewCBCEncrypter(block, iv).CryptBlocks(data, data)
		if err := os.WriteFile(seg, data, 0o644); err != nil {
			return err
		}
	}
	if !strings.Contains(out.String(), "#EXT-X-KEY:") {
		return fmt.Errorf("%s: no EXT-X-MAP to key after", name)
	}
	return os.WriteFile(playlist, []byte(out.String()), 0o644)
}

// SegmentAt finds the segment of a rendition playlist that holds time t, how far into it t falls, and the playlist's IV.
func SegmentAt(playlist []byte, t float64) (segment string, offset float64, iv []byte, err error) {
	var start, dur float64
	sc := bufio.NewScanner(bytes.NewReader(playlist))
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "#EXT-X-KEY:"):
			_, hexIV, _ := strings.Cut(line, "IV=0x")
			if iv, err = hex.DecodeString(hexIV); err != nil {
				return "", 0, nil, err
			}
		case strings.HasPrefix(line, "#EXTINF:"):
			if dur, err = strconv.ParseFloat(strings.TrimSuffix(strings.TrimPrefix(line, "#EXTINF:"), ","), 64); err != nil {
				return "", 0, nil, fmt.Errorf("bad segment duration %q", line)
			}
		case line != "" && !strings.HasPrefix(line, "#"):
			segment, offset = line, t-start
			if t < start+dur {
				return segment, offset, iv, nil
			}
			start += dur
		}
	}
	if segment == "" || iv == nil {
		return "", 0, nil, errors.New("rendition playlist has no encrypted segments")
	}
	return segment, min(offset, dur-0.05), iv, nil // t at the very end: last frame
}

func DecryptSegment(data, key, iv []byte) ([]byte, error) {
	if len(data) == 0 || len(data)%aes.BlockSize != 0 {
		return nil, errors.New("segment is not whole AES blocks")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	out := make([]byte, len(data))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(out, data)
	pad := int(out[len(out)-1])
	if pad == 0 || pad > aes.BlockSize {
		return nil, errors.New("bad padding")
	}
	return out[:len(out)-pad], nil
}

// FfmpegProgress is Ffmpeg that also calls report with the share of frames written (of frames), every couple of
// seconds, from ffmpeg's own -progress lines.
func FfmpegProgress(ctx context.Context, frames int, report func(float64), args ...string) error {
	cmd := sandboxed(ctx, "ffmpeg", append([]string{"-nostdin", "-v", "error", "-y", "-threads", strconv.Itoa(EncodeThreads), "-progress", "pipe:1", "-nostats"}, args...)...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	last, done := time.Time{}, 0
	lines := bufio.NewScanner(out)
	for lines.Scan() {
		line := lines.Text()
		if n, ok := strings.CutPrefix(line, "frame="); ok {
			if f, err := strconv.Atoi(n); err == nil {
				done = f
			}
		}
		// Every couple of seconds, and the final block whatever the clock says: a piece encoded inside the gap
		// (or one whose first block says frame=0, as ffmpeg 6 does) still reports where it got to.
		if frames > 0 && ((strings.HasPrefix(line, "frame=") && time.Since(last) >= 2*time.Second) || line == "progress=end") {
			last = time.Now()
			report(min(1, float64(done)/float64(frames)))
		}
	}
	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("ffmpeg: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

func Ffmpeg(ctx context.Context, args ...string) error {
	out, err := sandboxed(ctx, "ffmpeg", append([]string{"-nostdin", "-v", "error", "-y", "-threads", strconv.Itoa(EncodeThreads)}, args...)...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("ffmpeg: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
