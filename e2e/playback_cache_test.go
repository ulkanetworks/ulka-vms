package e2e

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/ulkanetworks/ulka-vms/app"
)

// TestPlaybackCacheForgets: playback facts are kept in memory, but a workspace's own changes apply to the very next
// request: making a video private, deleting the key a link was signed with, trashing it.
func TestPlaybackCacheForgets(t *testing.T) {
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
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25", "-t", "3",
		"-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", file).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v %s", err, out)
	}
	body, _ := os.ReadFile(file)
	_, key := h.signup("cache")
	c := h.client()
	up := h.call(c, "POST", "/v1/uploads", key, "", 201)
	h.sendUpload(up, body, http.StatusOK)
	asset := h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+up["id"].(string)+`","playback_policy":"public"}`, 201)
	path := "/v1/assets/" + asset["id"].(string)
	for start := time.Now(); asset["status"] != "complete" && time.Since(start) < time.Minute; time.Sleep(300 * time.Millisecond) {
		asset = h.call(c, "GET", path, key, "", 200)
	}
	watch := asset["embed_url"].(string)
	video := h.playPath(asset)
	get := func(u string) int {
		res, err := c.Get(u)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}

	for range 3 { // the second and third come from memory
		if s := get(watch + "/key"); s != http.StatusOK {
			t.Fatalf("public key: %d", s)
		}
	}
	h.call(c, "PATCH", path, key, `{"playback_policy":"signed"}`, 200)
	if s := get(watch + "/key"); s != http.StatusForbidden {
		t.Fatalf("made private, the next request without a signature got %d", s)
	}

	sk := h.call(c, "POST", "/v1/signing-keys", key, "", 201)
	secret, _ := base64.StdEncoding.DecodeString(sk["secret"].(string))
	signed := watch + "/key?token=" + url.QueryEscape(signURL(sk["id"].(string), secret, time.Now().Add(time.Hour).Unix(), video[len("/play"):]+"/*", "", ""))
	for range 2 {
		if s := get(signed); s != http.StatusOK {
			t.Fatalf("signed key: %d", s)
		}
	}
	h.call(c, "DELETE", "/v1/signing-keys/"+sk["id"].(string), key, "", 204)
	if s := get(signed); s != http.StatusForbidden {
		t.Fatalf("its signing key deleted, the link still got %d", s)
	}

	h.call(c, "PATCH", path, key, `{"playback_policy":"public"}`, 200)
	if s := get(watch + "/key"); s != http.StatusOK {
		t.Fatalf("public again: %d", s)
	}
	h.call(c, "POST", "/v1/assets/trash", key, `{"ids":["`+asset["id"].(string)+`"]}`, 204)
	if s := get(watch + "/key"); s != http.StatusNotFound {
		t.Fatalf("trashed, the next request got %d", s)
	}
}
