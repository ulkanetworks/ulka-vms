package e2e

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ulkanetworks/ulka-vms/app"
)

// TestUploadProbe drives both orderings: asset created before the upload finishes, and after.
func TestUploadProbe(t *testing.T) {
	h := newHarness(t)
	worker, err := app.NewWorkerClient(h.pool, h.store, h.cfg, app.Queues, app.Extension{})
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { worker.Stop(context.Background()) })

	video := filepath.Join(t.TempDir(), "in.mp4")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25", "-t", "2",
		"-pix_fmt", "yuv420p", video).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v %s", err, out)
	}
	good, _ := os.ReadFile(video)

	_, keyA := h.signup("a")
	clientB, keyB := h.signup("b")
	c := h.client()

	// Asset first, then the bytes.
	up := h.call(c, "POST", "/v1/uploads", keyA, "", 201)
	asset := h.call(c, "POST", "/v1/assets", keyA, `{"upload_id":"`+up["id"].(string)+`","passthrough":"lesson-1"}`, 201)
	if asset["status"] != "waiting" {
		t.Fatalf("asset before upload: %v", asset)
	}
	h.sendUpload(up, good, http.StatusOK)
	h.sendUpload(up, good, http.StatusConflict) // works once
	h.call(c, "POST", "/v1/assets", keyA, `{"upload_id":"`+up["id"].(string)+`"}`, 409)

	// Bytes first, then the asset; garbage input.
	bad := h.call(c, "POST", "/v1/uploads", keyA, "", 201)
	h.sendUpload(bad, []byte("not a video at all"), http.StatusOK)
	h.call(clientB, "POST", "/v1/assets", keyB, `{"upload_id":"`+bad["id"].(string)+`"}`, 404)
	badAsset := h.call(c, "POST", "/v1/assets", keyA, `{"upload_id":"`+bad["id"].(string)+`"}`, 201)

	// The plain upload: one PUT of the whole file to upload_url. An empty or unknown upload is refused.
	plain := h.call(c, "POST", "/v1/uploads", keyA, "", 201)
	h.putUpload(plain["upload_url"].(string), nil, http.StatusLengthRequired)
	h.putUpload(strings.Replace(plain["upload_url"].(string), plain["id"].(string), "00000000-0000-0000-0000-000000000000", 1), good, http.StatusNotFound)
	// A PUT that breaks part-way (the connection dropped, the API restarted) is simply sent again to the same address.
	broken, _ := http.NewRequest("PUT", plain["upload_url"].(string), io.MultiReader(bytes.NewReader(good[:10]), cutOff{}))
	broken.ContentLength = int64(len(good))
	if res, err := h.ts.Client().Do(broken); err == nil {
		res.Body.Close()
	}
	h.putUpload(plain["upload_url"].(string), good, http.StatusOK)
	h.putUpload(plain["upload_url"].(string), good, http.StatusConflict) // works once
	plainAsset := h.call(c, "POST", "/v1/assets", keyA, `{"upload_id":"`+plain["id"].(string)+`"}`, 201)
	if p := h.waitFor(keyA, "/v1/assets/"+plainAsset["id"].(string), func(a map[string]any) bool { return a["width"] != nil || a["status"] == "errored" }); p["width"] != 320.0 {
		t.Fatalf("plain upload didn't become a video: %v", p)
	}

	okPath, badPath := "/v1/assets/"+asset["id"].(string), "/v1/assets/"+badAsset["id"].(string)
	got := h.waitFor(keyA, okPath, func(a map[string]any) bool { return a["width"] != nil || a["status"] == "errored" })
	if got["width"] != 320.0 || got["height"] != 180.0 || got["duration_seconds"].(float64) < 1.9 || got["passthrough"] != "lesson-1" {
		t.Fatalf("probed asset: %v", got)
	}
	got = h.waitFor(keyA, badPath, func(a map[string]any) bool { return a["status"] == "errored" })
	if got["error_code"] != "source_undecodable" {
		t.Fatalf("bad asset: %v", got)
	}
	jobs := h.call(c, "GET", badPath+"/jobs", keyA, "", 200)["data"].([]any)
	if job := jobs[0].(map[string]any); job["status"] != "failed" || job["error_code"] != "source_undecodable" {
		t.Fatalf("bad asset job: %v", job)
	}

	h.call(c, "GET", okPath, keyB, "", 404)
	h.call(c, "GET", okPath+"/jobs", keyB, "", 404)
	h.call(c, "GET", "/v1/jobs/"+jobs[0].(map[string]any)["id"].(string), keyB, "", 404)
	if list := h.call(c, "GET", "/v1/assets", keyB, "", 200)["data"].([]any); len(list) != 0 {
		t.Fatalf("tenant B sees %v", list)
	}
}

// putUpload sends a file the plain way: one PUT of its bytes to the upload's address.
// cutOff is a request body whose connection drops after what came before it.
type cutOff struct{}

func (cutOff) Read([]byte) (int, error) { return 0, errors.New("connection dropped") }

func (h *harness) putUpload(url string, body []byte, wantStatus int) {
	h.t.Helper()
	req, _ := http.NewRequest("PUT", url, bytes.NewReader(body))
	res, err := h.ts.Client().Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != wantStatus {
		h.t.Fatalf("PUT %s: got %d, want %d", url, res.StatusCode, wantStatus)
	}
}

// sendUpload sends a file in two parts with Content-Range, as large files go, and checks the last answer's status.
func (h *harness) sendUpload(up map[string]any, body []byte, wantStatus int) {
	h.t.Helper()
	half := len(body) / 2
	for _, part := range [][2]int{{0, half}, {half, len(body)}} {
		if part[0] == part[1] {
			continue
		}
		req, _ := http.NewRequest("PUT", up["upload_url"].(string), bytes.NewReader(body[part[0]:part[1]]))
		req.Header.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", part[0], part[1]-1, len(body)))
		res, err := h.ts.Client().Do(req)
		if err != nil {
			h.t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusOK || part[1] == len(body) {
			if res.StatusCode != wantStatus {
				h.t.Fatalf("PUT part %v: got %d, want %d", part, res.StatusCode, wantStatus)
			}
			return
		}
	}
}

func (h *harness) waitFor(key, path string, done func(map[string]any) bool) map[string]any {
	h.t.Helper()
	for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); time.Sleep(200 * time.Millisecond) {
		if a := h.call(h.client(), "GET", path, key, "", 200); done(a) {
			return a
		}
	}
	h.t.Fatalf("%s did not settle in 30s", path)
	return nil
}
