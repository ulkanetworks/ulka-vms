package transcoder

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestSandboxHidesSecretsAndLimits(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://secret")
	out, err := sandboxed(t.Context(), "sh", "-c", "env; echo cpu=$(ulimit -t) file=$(ulimit -f) core=$(ulimit -c)").Output()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), "secret") {
		t.Fatalf("the environment leaked into the child:\n%s", out)
	}
	want := "cpu=" + strconv.Itoa(sandboxCPUSeconds) + " file=" + strconv.Itoa(sandboxFileBlocks) + " core=0"
	if !strings.Contains(string(out), want) {
		t.Fatalf("limits not applied, want %q in:\n%s", want, out)
	}
}

// A crafted playlist naming a local file must not be opened; a plain video must still probe.
func TestProbeRefusesPlaylists(t *testing.T) {
	dir := t.TempDir()
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-t", "1", "-c:v", "libx264", filepath.Join(dir, "ok.mp4")).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v %s", err, out)
	}
	playlist := "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n" + filepath.Join(dir, "ok.mp4") + "\n#EXT-X-ENDLIST\n"
	if err := os.WriteFile(filepath.Join(dir, "evil.m3u8"), []byte(playlist), 0o644); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.FileServer(http.Dir(dir)))
	defer srv.Close()
	if src, code, err := probeSource(t.Context(), srv.URL+"/ok.mp4"); err != nil || code != "" || src.Width != 320 {
		t.Fatalf("a plain video failed to probe: %+v %q %v", src, code, err)
	}
	if _, code, err := probeSource(t.Context(), srv.URL+"/evil.m3u8"); err != nil || code != "source_undecodable" {
		t.Fatalf("a playlist upload was accepted: code %q err %v", code, err)
	}
}
