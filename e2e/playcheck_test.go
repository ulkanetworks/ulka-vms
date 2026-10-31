package e2e

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ulkanetworks/ulka-vms/app"
	"github.com/ulkanetworks/ulka-vms/video"
)

// TestPlaybackCheck plays a finished private video through the check: settings, playlist, every quality unlocked, subtitles.
func TestPlaybackCheck(t *testing.T) {
	h := newHarness(t)
	worker, err := app.NewWorkerClient(h.pool, h.store, h.cfg, app.Queues, app.Extension{})
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { worker.Stop(context.Background()) })

	file := filepath.Join(t.TempDir(), "in.mp4")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=440",
		"-t", "4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", file).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v %s", err, out)
	}
	video.CheckClient = h.ts.Client()
	body, _ := os.ReadFile(file)
	_, key := h.signup("playcheck")
	c := h.client()
	up := h.call(c, "POST", "/v1/uploads", key, "", 201)
	h.sendUpload(up, body, http.StatusOK)
	asset := h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+up["id"].(string)+`","playback_policy":"signed"}`, 201)
	path := "/v1/assets/" + asset["id"].(string)
	h.call(c, "GET", path+"/playback-check", key, "", 404) // still processing
	for start := time.Now(); asset["status"] != "complete" && time.Since(start) < time.Minute; time.Sleep(300 * time.Millisecond) {
		asset = h.call(c, "GET", path, key, "", 200)
	}
	h.call(c, "GET", path+"/playback-check", key, "", 409) // private, and no signing key yet
	sk := h.call(c, "POST", "/v1/signing-keys", key, "", 201)
	h.call(c, "POST", path+"/captions?language=en&name=English", key, "1\n00:00:00,000 --> 00:00:02,000\nHello\n", 201)
	h.call(c, "GET", path+"/playback-check?page=not-a-page", key, "", 400)

	out := h.call(c, "GET", path+"/playback-check", key, "", 200)
	kinds := map[string]int{}
	for _, s := range out["data"].([]any) {
		s := s.(map[string]any)
		kinds[s["kind"].(string)]++
		if s["ok"] != true {
			t.Errorf("%s %s: %s", s["kind"], s["name"], s["message"])
		}
	}
	if kinds["settings"] != 1 || kinds["playlist"] != 1 || kinds["quality"] == 0 || kinds["subtitles"] != 1 {
		t.Fatalf("steps: %v", out["data"])
	}

	// The link check: each way a viewer's address fails, and one that plays.
	kid := sk["id"].(string)
	secret, _ := base64.StdEncoding.DecodeString(sk["secret"].(string))
	watch := asset["embed_url"].(string)
	video := strings.TrimPrefix(watch, h.cfg.PlayerURL)
	hour := time.Now().Add(time.Hour).Unix()
	good := signURL(kid, secret, hour, video+"/*", "", "")
	check := func(u, ip string) (bool, map[string]string) {
		b, _ := json.Marshal(map[string]string{"url": u, "ip": ip})
		out := h.call(c, "POST", path+"/link-check", key, string(b), 200)
		got := map[string]string{}
		for _, f := range out["data"].([]any) {
			f := f.(map[string]any)
			got[f["kind"].(string)] = f["state"].(string)
		}
		return out["plays"] == true, got
	}
	for name, tc := range map[string]struct {
		url, ip, kind, state string
		plays                bool
	}{
		"signed":           {watch + "?token=" + url.QueryEscape(good), "", "expiry", "ok", true},
		"as written":       {watch + "?token=" + good, "", "signature", "ok", true},
		"bare signature":   {good, "", "signature", "ok", true},
		"no signature":     {watch, "", "signature", "problem", false},
		"expired":          {watch + "?token=" + url.QueryEscape(signURL(kid, secret, time.Now().Add(-time.Minute).Unix(), video+"/*", "", "")), "", "expiry", "problem", false},
		"another acl":      {watch + "?token=" + url.QueryEscape(signURL(kid, secret, hour, "/other/*", "", "")), "", "signature", "problem", false},
		"unknown key":      {watch + "?token=" + url.QueryEscape(signURL("00000000-0000-4000-8000-000000000000", secret, hour, video+"/*", "", "")), "", "signature", "problem", false},
		"wrong secret":     {watch + "?token=" + url.QueryEscape(signURL(kid, []byte("nope"), hour, video+"/*", "", "")), "", "signature", "problem", false},
		"pinned, no ip":    {watch + "?token=" + url.QueryEscape(signURL(kid, secret, hour, video+"/*", "203.0.113.7", "")), "", "ip", "note", true},
		"pinned, other ip": {watch + "?token=" + url.QueryEscape(signURL(kid, secret, hour, video+"/*", "203.0.113.7", "")), "198.51.100.1", "signature", "problem", false},
		"another video":    {h.cfg.PlayerURL + "/" + asset["library_id"].(string) + "/00000000-0000-4000-8000-000000000000?token=" + url.QueryEscape(good), "", "video", "problem", false},
	} {
		if plays, got := check(tc.url, tc.ip); plays != tc.plays || got[tc.kind] != tc.state {
			t.Errorf("%s: plays %v, %v", name, plays, got)
		}
	}
	h.call(c, "POST", path+"/link-check", key, `{"url":""}`, 400)
	h.call(c, "POST", path+"/link-check", key, `{"url":"x","ip":"nope"}`, 400)

	h.call(c, "PATCH", "/v1/libraries/"+asset["library_id"].(string), key, `{"allowed_domains":["example.com"]}`, 200)
	out = h.call(c, "GET", path+"/playback-check?page="+url.QueryEscape("https://elsewhere.test/watch"), key, "", 200)
	if s := out["data"].([]any)[0].(map[string]any); s["ok"] != false || s["message"] != "This video can't be played on this distribution." {
		t.Fatalf("a page the library doesn't allow: %v", s)
	}
	if _, got := check(watch+"?token="+url.QueryEscape(good), ""); got["page"] != "note" {
		t.Errorf("a library with a distribution list and no page given: %v", got)
	}
	b, _ := json.Marshal(map[string]string{"url": watch + "?token=" + url.QueryEscape(good), "page": "https://elsewhere.test/watch"})
	if out := h.call(c, "POST", path+"/link-check", key, string(b), 200); out["plays"] != false {
		t.Errorf("a page the library doesn't allow: %v", out)
	}
}
