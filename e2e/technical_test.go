package e2e

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/ulkanetworks/ulka-vms/app"
)

func TestTechnicalDetails(t *testing.T) {
	h := newHarness(t)
	w, err := app.NewWorkerClient(h.pool, h.store, h.cfg, app.Queues, app.Extension{})
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { w.Stop(context.Background()) })

	video := filepath.Join(t.TempDir(), "in.mp4")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25", "-f", "lavfi", "-i", "sine=frequency=440",
		"-t", "4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", video).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v %s", err, out)
	}
	body, _ := os.ReadFile(video)
	c := h.client()
	_, key := h.signup("tech")
	_, keyB := h.signup("nosy")
	up := h.call(c, "POST", "/v1/uploads", key, "", 201)
	asset := h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+up["id"].(string)+`"}`, 201)
	h.sendUpload(up, body, http.StatusOK)
	path := "/v1/assets/" + asset["id"].(string)
	for start := time.Now(); asset["status"] != "complete" && time.Since(start) < time.Minute; time.Sleep(200 * time.Millisecond) {
		asset = h.call(c, "GET", path, key, "", 200)
	}
	if asset["status"] != "complete" {
		t.Fatalf("asset: %v", asset)
	}

	tech := h.call(c, "GET", path+"/technical", key, "", 200)
	src := tech["source"].(map[string]any)
	if src["video"].(map[string]any)["codec"] == "" || src["video"].(map[string]any)["width"] != 1280.0 || src["audio"].(map[string]any)["channels"] != 1.0 {
		t.Fatalf("source: %v", src)
	}
	plan := tech["plan"].(map[string]any)
	if plan["gop"] != 50.0 || plan["chunks"] != 1.0 || plan["encoder"].(map[string]any)["preset"] != "faster" {
		t.Fatalf("plan: %v", plan)
	}
	for _, task := range tech["tasks"].([]any) {
		if m := task.(map[string]any); m["done"] != true || m["state"] != "done" || m["node"] == "" || m["attempts"] != 1.0 {
			t.Fatalf("task after complete should be done once, on a node: %v", task)
		}
		m := task.(map[string]any)
		started, _ := time.Parse(time.RFC3339Nano, fmt.Sprint(m["started_at"]))
		done, _ := time.Parse(time.RFC3339Nano, fmt.Sprint(m["done_at"]))
		if started.IsZero() || done.Before(started) {
			t.Fatalf("a done piece says when it started and finished: %v", task)
		}
	}
	for _, st := range tech["timeline"].([]any) {
		if st.(map[string]any)["state"] != "done" {
			t.Fatalf("timeline of a complete video: %v", tech["timeline"])
		}
	}
	kinds := map[string]int{}
	for _, j := range tech["pipeline"].([]any) {
		job := j.(map[string]any)
		if job["state"] == "completed" && job["worker"] == "" {
			t.Fatalf("completed job without a worker: %v", job)
		}
		kinds[job["kind"].(string)]++
	}
	if kinds["probe"] != 1 || kinds["package"] < 1 || kinds["storyboard"] != 1 {
		t.Fatalf("pipeline kinds: %v", kinds)
	}
	stored := map[string]bool{}
	for _, g := range tech["storage"].([]any) {
		stored[g.(map[string]any)["name"].(string)] = g.(map[string]any)["bytes"].(float64) > 0
	}
	if !stored["720p"] || !stored["audio"] || !stored["playlists"] || stored["work"] {
		t.Fatalf("storage groups: %v", tech["storage"])
	}

	// Another tenant sees nothing: the asset is hidden by RLS, and River's rows by the explicit tenant filter.
	h.call(c, "GET", path+"/technical", keyB, "", 404)
}
