package e2e

import (
	"io"
	"net/url"
	"strings"
	"testing"
)

// TestSignedURLs mints signatures through the API; config.json answers before processing ends, so no worker is needed.
func TestSignedURLs(t *testing.T) {
	h := newHarness(t)
	session, key := h.signup("signer")
	_, keyB := h.signup("stranger")
	c := h.client()
	video := func() map[string]any {
		up := h.call(c, "POST", "/v1/uploads", key, "", 201)
		return h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+up["id"].(string)+`","playback_policy":"signed"}`, 201)
	}
	a, b := video(), video()
	id := `"video_id":"` + a["id"].(string) + `"`
	mint := func(auth, body string, want int) map[string]any {
		t.Helper()
		return h.call(c, "POST", "/v1/signed-urls", auth, "{"+body+"}", want)
	}
	mint(key, id, 409) // no signing key yet
	h.call(session, "POST", "/v1/signing-keys", "", "", 201)
	mint(key, id+`,"scope":"folder"`, 400)
	mint(key, id+`,"expires_in":10`, 400)
	mint(key, id+`,"expires_in":100000`, 400)
	mint(key, id+`,"ip":"not an address"`, 400)
	mint(key, id+`,"watermark":"`+strings.Repeat("x", 65)+`"`, 400)
	mint(keyB, id, 404)
	mint(key, `"video_id":"nosuchid"`, 404)

	status := func(url string) int {
		t.Helper()
		res, err := h.ts.Client().Get(url)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
		return res.StatusCode
	}
	other := strings.TrimPrefix(b["embed_url"].(string), h.cfg.PlayerURL) // /{library}/{video b}
	one := mint(key, id, 201)
	lib := mint(key, id+`,"scope":"library"`, 201)
	for addr, want := range map[string]int{
		strings.Replace(one["embed_url"].(string), "?", "/config.json?", 1):                          200,
		h.cfg.PlayerURL + other + "/config.json?token=" + url.QueryEscape(one["signature"].(string)): 403, // one video's signature
		h.cfg.PlayerURL + other + "/config.json?token=" + url.QueryEscape(lib["signature"].(string)): 200, // the whole library's
	} {
		if got := status(addr); got != want {
			t.Errorf("GET %s: %d, want %d", addr, got, want)
		}
	}

	// The watermark is signed: changing it breaks the signature.
	marked := mint(key, id+`,"watermark":"ada@example.com"`, 201)["embed_url"].(string)
	if got := status(strings.Replace(strings.Replace(marked, "ada%2540example.com", "eve%2540example.com", 1), "?", "/config.json?", 1)); got != 403 {
		t.Fatalf("changed watermark accepted: %d", got)
	}
}
