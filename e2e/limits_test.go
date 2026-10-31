package e2e

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/ulkanetworks/ulka-vms/app"
	"github.com/ulkanetworks/ulka-vms/core"
)

func TestLimits(t *testing.T) {
	h := newHarness(t)
	w, err := app.NewWorkerClient(h.pool, h.store, h.cfg, app.Queues, app.Extension{})
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { w.Stop(context.Background()) })
	c, key := h.signup("limited")
	tenant := h.call(c, "GET", "/v1/me", "", "", 200)["tenant"].(map[string]any)["id"].(string)
	setLimits := func(args ...string) error {
		return app.SetLimits(t.Context(), os.Getenv("TEST_OWNER_DATABASE_URL"), nil, append([]string{tenant}, args...))
	}

	// Defaults until the server's owner says otherwise.
	lim := h.call(c, "GET", "/v1/limits", "", "", 200)
	if lim["limits"].(map[string]any)["encode_minutes_monthly"].(float64) != float64(core.DefaultLimits.EncodeMinutesMonthly) {
		t.Fatalf("default limits: %v", lim)
	}
	for _, bad := range [][]string{{"encode_minutes_monthly=-1"}, {"encode_minutes_monthly=x"}, {"cdn_distributions=1"}, {"max_upload_bytes"}} {
		if err := setLimits(bad...); err == nil {
			t.Errorf("%v: want an error", bad)
		}
	}
	if err := app.SetLimits(t.Context(), os.Getenv("TEST_OWNER_DATABASE_URL"), nil, []string{"00000000-0000-4000-8000-000000000000", "max_upload_bytes=1"}); err == nil {
		t.Error("an unknown workspace: want an error")
	}
	if err := setLimits("max_upload_bytes=1000"); err != nil {
		t.Fatal(err)
	}
	if got := h.call(c, "GET", "/v1/limits", "", "", 200)["limits"].(map[string]any); got["max_upload_bytes"].(float64) != 1000 ||
		got["encode_minutes_monthly"].(float64) != float64(core.DefaultLimits.EncodeMinutesMonthly) {
		t.Fatalf("after setting one limit: %v", got)
	}

	// Uploads over the size limit are refused before any byte is stored.
	clip := filepath.Join(t.TempDir(), "in.mp4")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25", "-t", "2", "-pix_fmt", "yuv420p", clip).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v %s", err, out)
	}
	body, _ := os.ReadFile(clip)
	up := h.call(c, "POST", "/v1/uploads", key, "", 201)
	h.sendUpload(up, body, http.StatusRequestEntityTooLarge)
	h.putUpload(up["upload_url"].(string), body, http.StatusRequestEntityTooLarge)

	// With room to upload but no encoding minutes left, the video stops before encoding, with its own reason.
	if err := setLimits("max_upload_bytes=5368709120", "encode_minutes_monthly=0"); err != nil {
		t.Fatal(err)
	}
	up = h.call(c, "POST", "/v1/uploads", key, "", 201)
	asset := h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+up["id"].(string)+`"}`, 201)
	h.sendUpload(up, body, http.StatusOK)
	got := h.waitFor(key, "/v1/assets/"+asset["id"].(string), func(a map[string]any) bool { return a["status"] == "errored" })
	if got["error_code"] != "encode_limit_reached" {
		t.Fatalf("over the minutes: %v", got)
	}
	if used := h.call(c, "GET", "/v1/limits", "", "", 200)["used"].(map[string]any); used["encode_minutes"] == nil {
		t.Fatalf("used: %v", used)
	}
}
