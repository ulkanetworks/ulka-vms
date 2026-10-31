package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/ulkanetworks/ulka-vms/app"
)

// TestPoster: a video offers frames as covers, one can be chosen or a picture uploaded, and poster.* follows; a file
// that isn't a picture is refused, and null goes back to the default frame.
func TestPoster(t *testing.T) {
	h := newHarness(t)
	w, err := app.NewWorkerClient(h.pool, h.store, h.cfg, app.Queues, app.Extension{})
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { w.Stop(context.Background()) })
	dir := t.TempDir()
	video, picture := filepath.Join(dir, "in.mp4"), filepath.Join(dir, "cover.png")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25", "-t", "4", "-pix_fmt", "yuv420p", video).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v %s", err, out)
	}
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=red:size=640x360", "-frames:v", "1", picture).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v %s", err, out)
	}
	body, _ := os.ReadFile(video)
	_, key := h.signup("poster")
	_, other := h.signup("poster-other")
	c := h.client()
	up := h.call(c, "POST", "/v1/uploads", key, "", 201)
	h.sendUpload(up, body, http.StatusOK)
	asset := h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+up["id"].(string)+`","playback_policy":"public"}`, 201)
	id := asset["id"].(string)
	for start := time.Now(); asset["status"] != "complete" && time.Since(start) < time.Minute; time.Sleep(200 * time.Millisecond) {
		asset = h.call(c, "GET", "/v1/assets/"+id, key, "", 200)
	}
	poster := asset["poster"].(map[string]any)
	if poster["source"] != "default" || len(poster["suggestions"].([]any)) != 6 || poster["time"] != poster["suggestions"].([]any)[0] {
		t.Fatalf("default poster: %v", poster)
	}
	get := func() []byte {
		t.Helper()
		res, err := h.ts.Client().Get(h.ts.URL + h.playPath(asset) + "/poster.jpg")
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		if res.StatusCode != 200 || res.Header.Get("Cache-Control") != "public, max-age=300" {
			t.Fatalf("poster: %d %q", res.StatusCode, res.Header.Get("Cache-Control"))
		}
		return b
	}
	first := get()
	// The player's config names the thumbnail by its choice, so an embed shows a new one at once.
	posterIn := func() string {
		t.Helper()
		res, err := h.ts.Client().Get(h.ts.URL + h.playPath(asset) + "/config.json")
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var c struct{ Poster string }
		if err := json.NewDecoder(res.Body).Decode(&c); err != nil {
			t.Fatal(err)
		}
		return c.Poster
	}
	if got := posterIn(); got != "poster.jpg?v=default" {
		t.Fatalf("config poster: %q", got)
	}

	h.call(c, "PUT", "/v1/assets/"+id+"/poster", key, `{"time":99}`, 400)
	h.call(c, "PUT", "/v1/assets/"+id+"/poster", other, `{"time":1}`, 404)
	if p := h.call(c, "PUT", "/v1/assets/"+id+"/poster", key, `{"time":3.2}`, 200)["poster"].(map[string]any); p["source"] != "frame" || p["time"] != 3.2 {
		t.Fatalf("frame: %v", p)
	}
	if bytes.Equal(get(), first) {
		t.Fatal("poster.jpg didn't change to the chosen frame")
	}
	if got := posterIn(); got != "poster.jpg?v=t3.2" {
		t.Fatalf("config poster after choosing a frame: %q", got)
	}

	put := func(auth string, b []byte, want int) map[string]any {
		t.Helper()
		return h.call(c, "PUT", "/v1/assets/"+id+"/poster/image", auth, string(b), want)
	}
	put(key, []byte("not a picture"), 422)
	png, _ := os.ReadFile(picture)
	put(other, png, 404)
	if p := put(key, png, 200)["poster"].(map[string]any); p["source"] != "upload" || p["time"] != nil {
		t.Fatalf("upload: %v", p)
	}
	if b := get(); len(b) < 3 || b[0] != 0xff || b[1] != 0xd8 {
		t.Fatalf("uploaded cover isn't a JPEG: % x", b[:min(len(b), 4)])
	}

	if p := h.call(c, "PUT", "/v1/assets/"+id+"/poster", key, `{"time":null}`, 200)["poster"].(map[string]any); p["source"] != "default" {
		t.Fatalf("back to default: %v", p)
	}
	if !bytes.Equal(get(), first) {
		t.Fatal("poster.jpg didn't go back to the default frame")
	}
}
