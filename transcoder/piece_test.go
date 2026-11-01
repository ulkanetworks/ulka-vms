package transcoder

import (
	"os/exec"
	"path/filepath"
	"testing"
)

func TestPieceFrames(t *testing.T) {
	p := Plan{ChunkFrames: 200, Chunks: 3}
	full, half := Rung{Name: "720p"}, Rung{Name: "360p", Half: true}
	for _, c := range []struct {
		r     Rung
		chunk int
		want  int
	}{
		{full, 0, 200}, // a piece before the last holds exactly ChunkFrames
		{half, 1, 100}, // at half the frame rate, half of them
		{full, 2, 100}, // the last runs to the end: 20 s at 25 fps is 500 frames, 400 in the pieces before
		{half, 2, 50},
	} {
		if got := pieceFrames(p, c.r, c.chunk, 20, 25); got != c.want {
			t.Errorf("%s piece %d: %d frames, want %d", c.r.Name, c.chunk, got, c.want)
		}
	}
}

// A piece cut short (the source's read ended early, yet ffmpeg exited cleanly) is refused, so its task is encoded
// again instead of packaging failing on it for ever.
func TestCheckPieceRefusesAShortPiece(t *testing.T) {
	piece := filepath.Join(t.TempDir(), "piece.mp4")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25", "-frames:v", "25",
		"-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", piece).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v %s", err, out)
	}
	if err := checkPiece(t.Context(), piece, 200); err == nil {
		t.Fatal("a piece of 25 frames passed for one of 200")
	}
	for _, want := range []int{25, 27} { // whole, or a frame or two of rounding short
		if err := checkPiece(t.Context(), piece, want); err != nil {
			t.Errorf("want %d: %v", want, err)
		}
	}
}
