package e2e

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ulkanetworks/ulka-vms/app"
)

// A library's active preset decides what its next video is encoded as, and the API keeps presets honest.
func TestTranscodingPresets(t *testing.T) {
	h := newHarness(t)
	worker, err := app.NewWorkerClient(h.pool, h.store, h.cfg, app.Queues, app.Extension{})
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { worker.Stop(context.Background()) })

	c, key := h.signup("presets")
	code := func(out map[string]any) string { return out["error"].(map[string]any)["code"].(string) }
	str := func(m map[string]any, k string) string { s, _ := m[k].(string); return s }
	lib := str(h.call(c, "POST", "/v1/libraries", "", `{"name":"Lessons"}`, 201), "id")
	path := "/v1/libraries/" + lib

	// Templates are built in; a new library uses Balanced.
	tc := h.call(c, "GET", path+"/transcoding", "", "", 200)
	if tc["active_template"] != "balanced" || tc["active_preset"] != nil || len(tc["templates"].([]any)) < 5 || len(tc["presets"].([]any)) != 0 {
		t.Fatalf("transcoding: %v", tc)
	}

	// Presets are validated, named uniquely, and a template key is checked.
	for _, bad := range []string{`{"name":"x","heights":[],"quality":"balanced"}`, `{"name":"x","heights":[1440],"quality":"balanced"}`, `{"name":"x","heights":[720],"quality":"ultra"}`, `{"heights":[720],"quality":"fast"}`} {
		if out := h.call(c, "POST", path+"/presets", "", bad, 400); code(out) != "invalid_preset" {
			t.Fatalf("%s: %v", bad, out)
		}
	}
	made := h.call(c, "POST", path+"/presets", "", `{"name":"Small","description":"Phones only","heights":[360,240,360],"quality":"fast"}`, 201)
	pid := str(made, "id")
	if hs := made["heights"].([]any); len(hs) != 2 || hs[0] != 240.0 || hs[1] != 360.0 {
		t.Fatalf("heights should be sorted and unique: %v", made["heights"])
	}
	if out := h.call(c, "POST", path+"/presets", "", `{"name":"small","heights":[720],"quality":"high"}`, 409); code(out) != "preset_name_taken" {
		t.Fatalf("duplicate: %v", out)
	}
	h.call(c, "PUT", path+"/transcoding", "", `{"template":"nonsense"}`, 400)
	h.call(c, "PUT", path+"/transcoding", "", `{"template":"best","preset_id":"`+pid+`"}`, 400)
	h.call(c, "PATCH", "/v1/presets/"+pid, "", `{"description":"Small screens only"}`, 204)

	// A preset of another workspace can't be chosen.
	oc, _ := h.signup("elsewhere")
	olib := str(h.call(oc, "POST", "/v1/libraries", "", `{"name":"Theirs"}`, 201), "id")
	theirs := str(h.call(oc, "POST", "/v1/libraries/"+olib+"/presets", "", `{"name":"Theirs","heights":[480],"quality":"high"}`, 201), "id")
	h.call(c, "PUT", path+"/transcoding", "", `{"preset_id":"`+theirs+`"}`, 400)

	// The chosen preset is what the next video becomes: only 240p and 360p, though the source is 720p.
	h.call(c, "PUT", path+"/transcoding", "", `{"preset_id":"`+pid+`"}`, 200)
	if out := h.call(c, "DELETE", "/v1/presets/"+pid, "", "", 409); code(out) != "preset_in_use" {
		t.Fatalf("in use: %v", out)
	}
	video := filepath.Join(t.TempDir(), "in.mp4")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25", "-f", "lavfi", "-i", "sine=frequency=440",
		"-t", "6", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", video).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v %s", err, out)
	}
	body, _ := os.ReadFile(video)
	up := h.call(c, "POST", "/v1/uploads", key, "", 201)
	h.sendUpload(up, body, http.StatusOK)
	asset := h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+up["id"].(string)+`","library_id":"`+lib+`"}`, 201)
	for start := time.Now(); asset["status"] != "complete" && time.Since(start) < time.Minute; time.Sleep(300 * time.Millisecond) {
		asset = h.call(c, "GET", "/v1/assets/"+asset["id"].(string), key, "", 200)
	}
	if asset["status"] != "complete" {
		t.Fatalf("asset: %v", asset)
	}
	var names []string
	for _, r := range asset["renditions"].([]any) {
		names = append(names, r.(map[string]any)["name"].(string))
	}
	if strings.Join(names, ",") != "360p,240p" {
		t.Fatalf("renditions %v, want only the preset's heights", names)
	}

	// Back on a template, the preset can go.
	h.call(c, "PUT", path+"/transcoding", "", `{"template":"courses"}`, 200)
	h.call(c, "DELETE", "/v1/presets/"+pid, "", "", 204)
	if got := h.call(c, "GET", path+"/transcoding", "", "", 200); got["active_template"] != "courses" || len(got["presets"].([]any)) != 0 {
		t.Fatalf("after: %v", got)
	}
}
