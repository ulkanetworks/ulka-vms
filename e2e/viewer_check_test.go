package e2e

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/ulkanetworks/ulka-vms/app"
)

// A viewer runs the check on the player host: the server explains their address without needing it to work, keeps
// what their browser found under a code, and the workspace and Ulka admin read it back.
func TestViewerCheck(t *testing.T) {
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
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-t", "4",
		"-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", video).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v %s", err, out)
	}
	body, _ := os.ReadFile(video)
	_, key := h.signup("check")
	c := h.client()
	up := h.call(c, "POST", "/v1/uploads", key, "", 201)
	h.sendUpload(up, body, http.StatusOK)
	asset := h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+up["id"].(string)+`","playback_policy":"signed"}`, 201)
	id := asset["id"].(string)
	for start := time.Now(); asset["status"] != "complete" && time.Since(start) < time.Minute; time.Sleep(300 * time.Millisecond) {
		asset = h.call(c, "GET", "/v1/assets/"+id, key, "", 200)
	}
	sk := h.call(c, "POST", "/v1/signing-keys", key, "", 201)
	secret, _ := base64.StdEncoding.DecodeString(sk["secret"].(string))
	page := h.playPath(asset)
	addr := strings.TrimPrefix(page, "/play")

	check := func(query string, want int) map[string]any {
		t.Helper()
		res, err := h.ts.Client().Get(h.ts.URL + page + "/check.json" + query)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		if res.StatusCode != want || res.Header.Get("Access-Control-Allow-Origin") != "*" || res.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("check.json%s: %d %v %s", query, res.StatusCode, res.Header, b)
		}
		out := map[string]any{}
		json.Unmarshal(b, &out)
		return out
	}
	problem := func(m map[string]any, kind string) bool {
		for _, f := range m["findings"].([]any) {
			if f := f.(map[string]any); f["kind"] == kind && f["state"] == "problem" {
				return true
			}
		}
		return false
	}
	// No token on a private video: it explains instead of refusing.
	if m := check("", 200); m["plays"] != false || !problem(m, "signature") || m["viewer"].(map[string]any)["ip"] != "127.0.0.1" || m["server_time"] == "" || m["status"] != "complete" {
		t.Fatalf("unsigned check: %v", m)
	}
	expired := signURL(sk["id"].(string), secret, time.Now().Add(-time.Minute).Unix(), addr+"/*", "", "")
	if m := check("?token="+expired, 200); m["plays"] != false || !problem(m, "expiry") {
		t.Fatalf("expired check: %v", m)
	}
	good := signURL(sk["id"].(string), secret, time.Now().Add(time.Hour).Unix(), addr+"/*", "", "")
	if m := check("?token="+good, 200); m["plays"] != true {
		t.Fatalf("signed check: %v", m)
	}
	check2, _ := h.ts.Client().Get(h.ts.URL + "/play" + addr[:strings.LastIndex(addr, "/")] + "/00000000-0000-4000-8000-000000000000/check.json")
	if check2.StatusCode != 404 {
		t.Fatalf("a video that doesn't exist: %d", check2.StatusCode)
	}

	report := func(body string, want int) map[string]any {
		t.Helper()
		res, err := h.ts.Client().Post(h.ts.URL+page+"/report", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		if res.StatusCode != want {
			t.Fatalf("report: %d %s", res.StatusCode, b)
		}
		out := map[string]any{}
		json.Unmarshal(b, &out)
		return out
	}
	report(`{"plays":true}`, 400)
	report(`not json`, 400)
	sent := report(`{"plays":false,"results":[{"id":"key","state":"problem","ms":120,"detail":"refused"}]}`, 201)
	code, _ := sent["code"].(string)
	if !regexp.MustCompile(`^UL-[0-9A-Z]{6}$`).MatchString(code) {
		t.Fatalf("report code: %v", sent)
	}
	if got := report(`{"plays":true,"results":[]}`, 429); got["error"].(map[string]any)["code"] != "report_too_soon" {
		t.Fatalf("second report at once: %v", got)
	}

	list := h.call(c, "GET", "/v1/assets/"+id+"/playback-reports", key, "", 200)
	rows := list["data"].([]any)
	if len(rows) != 1 || list["total"].(float64) != 1 {
		t.Fatalf("reports: %v", list)
	}
	row := rows[0].(map[string]any)
	if row["code"] != code || row["plays"] != false || row["ip"] != "127.0.0.1" || len(row["results"].([]any)) != 1 {
		t.Fatalf("report row: %v", row)
	}
	_, other := h.signup("check-other")
	h.call(c, "GET", "/v1/assets/"+id+"/playback-reports", other, "", 404)
	if got := h.call(c, "GET", "/v1/playback-reports/"+strings.ToLower(code), key, "", 200); got["asset_id"] != id || got["code"] != code {
		t.Fatalf("workspace lookup: %v", got)
	}
	h.call(c, "GET", "/v1/playback-reports/"+code, other, "", 404)
}
