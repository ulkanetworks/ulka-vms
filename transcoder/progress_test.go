package transcoder

import "testing"

// ffmpeg's -progress lines reach report as a share of the frames, and stderr stays the error text.
func TestFfmpegProgress(t *testing.T) {
	var got []float64
	err := FfmpegProgress(t.Context(), 250, func(s float64) { got = append(got, s) },
		"-f", "lavfi", "-i", "testsrc=duration=10:size=160x90:rate=25", "-f", "null", "-")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) == 0 || got[len(got)-1] <= 0 || got[len(got)-1] > 1 {
		t.Fatalf("reports: %v", got)
	}
	if err := FfmpegProgress(t.Context(), 1, func(float64) {}, "-i", "/no/such/file.mp4", "-f", "null", "-"); err == nil {
		t.Fatal("a failing ffmpeg must fail")
	}
}
