package e2e

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ulkanetworks/ulka-vms/app"
	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/webhooks"
)

func TestWebhooks(t *testing.T) {
	h := newHarness(t)
	var (
		mu      sync.Mutex
		secrets = map[string]string{}
		got     = map[string][]core.Event{}
	)
	recv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		defer mu.Unlock()
		sig := r.Header.Get("Ulka-Signature")
		ts, v1, _ := strings.Cut(strings.TrimPrefix(sig, "t="), ",v1=")
		mac := hmac.New(sha256.New, []byte(secrets[r.URL.Path]))
		mac.Write([]byte(ts + "." + string(body)))
		if !hmac.Equal([]byte(v1), []byte(hex.EncodeToString(mac.Sum(nil)))) {
			t.Errorf("bad signature %q on %s", sig, r.URL.Path)
		}
		var ev core.Event
		json.Unmarshal(body, &ev)
		got[r.URL.Path] = append(got[r.URL.Path], ev)
	}))
	defer recv.Close()
	saved := webhooks.WebhookClient
	webhooks.WebhookClient = recv.Client() // the test receiver is on loopback, which the real client refuses
	t.Cleanup(func() { webhooks.WebhookClient = saved })
	webhooks.CheckHost = func(context.Context, string) error { return nil }
	t.Cleanup(func() { webhooks.CheckHost = core.CheckPublicHost })

	worker, err := app.NewWorkerClient(h.pool, h.store, h.cfg, app.Queues, app.Extension{})
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { worker.Stop(context.Background()) })

	c := h.client()
	_, keyA := h.signup("hooks")
	_, keyB := h.signup("bystander")
	h.call(c, "POST", "/v1/webhook-endpoints", keyA, `{"url":"http://example.com/hook"}`, 400)
	for key, path := range map[string]string{keyA: "/a", keyB: "/b"} {
		ep := h.call(c, "POST", "/v1/webhook-endpoints", key, `{"url":"`+recv.URL+path+`"}`, 201)
		mu.Lock()
		secrets[path] = ep["secret"].(string)
		mu.Unlock()
	}

	// An endpoint gets only the events it chose, and none while switched off.
	h.call(c, "POST", "/v1/webhook-endpoints", keyA, `{"url":"`+recv.URL+`/x","events":["asset.nope"]}`, 400)
	chosen := h.call(c, "POST", "/v1/webhook-endpoints", keyA, `{"name":"Errors only","url":"`+recv.URL+`/chosen","events":["asset.errored"]}`, 201)
	off := h.call(c, "POST", "/v1/webhook-endpoints", keyA, `{"name":"Paused","url":"`+recv.URL+`/off"}`, 201)
	mu.Lock()
	secrets["/chosen"], secrets["/off"] = chosen["secret"].(string), off["secret"].(string)
	mu.Unlock()
	if got := h.call(c, "PATCH", "/v1/webhook-endpoints/"+off["id"].(string), keyA, `{"enabled":false}`, 200); got["enabled"] != false || got["name"] != "Paused" {
		t.Fatalf("switched off: %v", got)
	}

	video := filepath.Join(t.TempDir(), "in.mp4")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25", "-t", "3", "-pix_fmt", "yuv420p", video).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v %s", err, out)
	}
	good, _ := os.ReadFile(video)
	ok := h.call(c, "POST", "/v1/uploads", keyA, "", 201)
	okAsset := h.call(c, "POST", "/v1/assets", keyA, `{"upload_id":"`+ok["id"].(string)+`"}`, 201)["id"].(string)
	h.sendUpload(ok, good, http.StatusOK)
	bad := h.call(c, "POST", "/v1/uploads", keyA, "", 201)
	badAsset := h.call(c, "POST", "/v1/assets", keyA, `{"upload_id":"`+bad["id"].(string)+`"}`, 201)["id"].(string)
	h.sendUpload(bad, []byte("garbage"), http.StatusOK)

	want := map[string][]string{
		okAsset:  {"asset.complete", "asset.created", "asset.ready", "job.completed", "job.started", "upload.completed"},
		badAsset: {"asset.created", "asset.errored", "job.failed", "job.started", "upload.completed"},
	}
	byAsset := func() map[string][]string {
		mu.Lock()
		defer mu.Unlock()
		out := map[string][]string{}
		for _, ev := range got["/a"] {
			d := ev.Data.(map[string]any)
			id, _ := d["asset_id"].(string)
			if id == "" {
				id, _ = d["id"].(string)
			}
			out[id] = append(out[id], ev.Type)
		}
		for id := range out {
			slices.Sort(out[id])
		}
		return out
	}
	deadline := time.Now().Add(time.Minute)
	for time.Now().Before(deadline) && !(slices.Equal(byAsset()[okAsset], want[okAsset]) && slices.Equal(byAsset()[badAsset], want[badAsset])) {
		time.Sleep(200 * time.Millisecond)
	}
	time.Sleep(time.Second) // catch duplicates arriving late
	for id, types := range want {
		if g := byAsset()[id]; !slices.Equal(g, types) {
			t.Errorf("asset %s: got events %v, want each of %v exactly once", id, g, types)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got["/b"]) != 0 {
		t.Errorf("another tenant's endpoint received %d events", len(got["/b"]))
	}
	if len(got["/off"]) != 0 {
		t.Errorf("a switched-off endpoint received %d events", len(got["/off"]))
	}
	if len(got["/chosen"]) != 1 || got["/chosen"][0].Type != "asset.errored" {
		t.Errorf("the endpoint choosing asset.errored got %v", got["/chosen"])
	}
	for _, ev := range got["/a"] {
		if !strings.HasPrefix(ev.ID, "evt_") || ev.CreatedAt.IsZero() {
			t.Errorf("event envelope: %+v", ev)
		}
		if ev.Type == "asset.errored" && ev.Data.(map[string]any)["error_code"] != "source_undecodable" {
			t.Errorf("errored event data: %v", ev.Data)
		}
	}
}
