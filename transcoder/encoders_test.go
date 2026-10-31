package transcoder

import (
	"slices"
	"testing"
)

func TestVideoEncoders(t *testing.T) {
	out := []byte(` V....D a64multi             Multicolor charset for Commodore 64 (codec a64_multi)
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D hevc_videotoolbox    VideoToolbox H.265 Encoder (codec hevc)
 A....D aac                  AAC (Advanced Audio Coding)
 V....D libsvtav1            SVT-AV1(Scalable Video Technology for AV1) encoder (codec av1)`)
	if got := videoEncoders(out); !slices.Equal(got, []string{"av1", "h264", "hevc"}) {
		t.Fatalf("got %v", got)
	}
	if got := videoEncoders([]byte(" A....D aac  AAC")); len(got) != 0 {
		t.Fatalf("audio-only ffmpeg reported %v", got)
	}
}
