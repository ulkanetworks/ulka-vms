package e2e

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ulkanetworks/ulka-vms/app"
	videomod "github.com/ulkanetworks/ulka-vms/video"
)

// signURL is what a customer's server does: HMAC-SHA256 over exp~acl~kid[~ip][~wm], the text that goes in ?token=.
func signURL(kid string, secret []byte, exp int64, acl, ip, wm string) string {
	esc := func(v string) string { return strings.ReplaceAll(url.QueryEscape(v), "~", "%7E") }
	signed := "exp=" + strconv.FormatInt(exp, 10) + "~acl=" + esc(acl) + "~kid=" + kid
	if ip != "" {
		signed += "~ip=" + esc(ip)
	}
	if wm != "" {
		signed += "~wm=" + esc(wm)
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(signed))
	return signed + "~hmac=" + hex.EncodeToString(mac.Sum(nil))
}

// playPath is a video's address on the player host as the test server serves it (PLAYER_URL is <server>/play).
func (h *harness) playPath(asset map[string]any) string {
	return strings.TrimPrefix(asset["embed_url"].(string), h.ts.URL)
}

func TestPlayback(t *testing.T) {
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
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25", "-f", "lavfi", "-i", "sine=frequency=440",
		"-t", "10", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", video).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v %s", err, out)
	}
	body, _ := os.ReadFile(video)

	sess, key := h.signup("play")
	_, keyB := h.signup("other")
	c := h.client()
	up := h.call(c, "POST", "/v1/uploads", key, "", 201)
	h.sendUpload(up, body, http.StatusOK)
	asset := h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+up["id"].(string)+`","playback_policy":"signed"}`, 201)
	assetPath := "/v1/assets/" + asset["id"].(string)
	for start := time.Now(); asset["status"] != "complete" && time.Since(start) < time.Minute; time.Sleep(300 * time.Millisecond) {
		asset = h.call(c, "GET", assetPath, key, "", 200)
	}
	if asset["status"] != "complete" {
		t.Fatalf("asset: %v", asset)
	}

	sk := h.call(c, "POST", "/v1/signing-keys", key, "", 201)
	kid := sk["id"].(string)
	secret, _ := base64.StdEncoding.DecodeString(sk["secret"].(string))
	exp := time.Now().Add(time.Hour).Unix()
	page := h.playPath(asset)                      // /play/{library}/{video}
	addr := strings.TrimPrefix(page, "/play")      // /{library}/{video}, what an acl names
	library := addr[:strings.LastIndex(addr, "/")] // /{library}
	sign := func(sig, file string) string { return page + "/" + file + "?token=" + sig }
	sig := signURL(kid, secret, exp, addr+"/*", "", "")

	get := func(path string, want int, wantCode string) (string, http.Header) {
		t.Helper()
		res, err := h.ts.Client().Get(h.ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		if res.StatusCode != want || (wantCode != "" && !strings.Contains(string(b), `"`+wantCode+`"`)) {
			t.Fatalf("GET %s: %d %s, want %d %s", path, res.StatusCode, b, want, wantCode)
		}
		if res.Header.Get("Access-Control-Allow-Origin") != "*" {
			t.Fatalf("GET %s: no CORS header", path)
		}
		return string(b), res.Header
	}
	get(page+"/playlist.m3u8", 403, "token_required")
	get(sign(signURL(kid, []byte("wrong secret"), exp, addr+"/*", "", ""), "playlist.m3u8"), 403, "token_invalid")
	get(sign(signURL(kid, secret, exp, library+"/someoneelse/*", "", ""), "playlist.m3u8"), 403, "token_invalid")
	get(sign(signURL(kid, secret, time.Now().Add(-time.Minute).Unix(), addr+"/*", "", ""), "playlist.m3u8"), 403, "token_expired")
	// Starting needs a link that hasn't expired; a session it started goes on for the video's length plus an hour.
	expired := signURL(kid, secret, time.Now().Add(-time.Minute).Unix(), addr+"/*", "", "")
	get(sign(expired, "config.json"), 403, "token_expired")
	get(sign(expired, "720p.m3u8"), 200, "")
	get(sign(expired, "key"), 200, "")
	get(sign(signURL(kid, secret, time.Now().Add(-2*time.Hour).Unix(), addr+"/*", "", ""), "720p.m3u8"), 403, "token_expired") // a 10 s video: grace is over
	get(sign(signURL(kid, []byte("wrong secret"), time.Now().Add(-time.Minute).Unix(), addr+"/*", "", ""), "720p.m3u8"), 403, "token_invalid")
	get(sign(signURL(kid, secret, exp, addr+"/*", "198.51.100.9", ""), "playlist.m3u8"), 403, "token_invalid") // another viewer's address
	get(sign(signURL(kid, secret, exp, addr+"/*", "127.0.0.1", ""), "playlist.m3u8"), 200, "")
	get(sign(signURL(kid, secret, exp, library+"/*", "", ""), "playlist.m3u8"), 200, "") // a whole library
	tampered := strings.Replace(sig, "exp=", "exp=9", 1)
	get(sign(tampered, "playlist.m3u8"), 403, "token_invalid")
	get("/play"+library+"/00000000-0000-4000-8000-000000000000/playlist.m3u8", 404, "not_found")

	// Links inside are relative and carry the token, so the one signature reaches the qualities, key and captions.
	m, _ := get(sign(sig, "playlist.m3u8"), 200, "")
	withToken := "?token=" + url.QueryEscape(sig)
	if !strings.Contains(m, "\n720p.m3u8"+withToken+"\n") || !strings.Contains(m, `URI="audio.m3u8`+withToken+`"`) {
		t.Fatalf("master links don't carry the token:\n%s", m)
	}
	// Written as signed or URL-encoded once more, the token works.
	get(page+"/playlist.m3u8"+withToken, 200, "")
	rendition, _ := get(sign(sig, "720p.m3u8"), 200, "")
	if !strings.Contains(rendition, `URI="key`+withToken+`"`) {
		t.Fatalf("rendition key not beside it:\n%s", rendition)
	}
	if !regexp.MustCompile(`(?m)^http://[^\n]+/720p/1\.m4s$`).MatchString(rendition) {
		t.Fatalf("segments do not point at the origin:\n%s", rendition)
	}
	get(sign(sig, "1080p.m3u8"), 404, "not_found")
	get(sign(sig, "..%2Fsource%2Foriginal.m3u8"), 404, "not_found")
	aesKey, hdr := get(sign(sig, "key"), 200, "")
	if len(aesKey) != 16 || hdr.Get("Cache-Control") != "no-store" {
		t.Fatalf("key: %d bytes, cache %q", len(aesKey), hdr.Get("Cache-Control"))
	}
	get(page+"/key", 403, "token_required")

	// A real player path: ffmpeg follows master → rendition → key → encrypted segments over HTTP.
	// Plain HTTP because this ffmpeg verifies certificates and the test server's is self-signed.
	plain := httptest.NewServer(h.handler)
	defer plain.Close()
	stats, _ := exec.Command("ffmpeg", "-hide_banner", "-i", plain.URL+sign(sig, "playlist.m3u8"), "-map", "0:v:0", "-f", "null", "-").CombinedOutput()
	frames := regexp.MustCompile(`frame=\s*(\d+)`).FindAllStringSubmatch(string(stats), -1)
	if len(frames) == 0 {
		t.Fatalf("ffmpeg could not play the stream:\n%s", stats)
	}
	if n, _ := strconv.Atoi(frames[len(frames)-1][1]); n != 250 {
		t.Fatalf("played %d frames, want 250:\n%s", n, stats)
	}

	// Ulka signs URLs too, and its watermark reaches the player's config under the same signature.
	signed := h.call(c, "POST", "/v1/signed-urls", key, `{"video_id":"`+asset["id"].(string)+`","watermark":"ada@example.com","expires_in":600}`, 201)
	get(strings.TrimPrefix(signed["playback_url"].(string), h.ts.URL), 200, "")
	if cfg, _ := get(strings.Replace(strings.TrimPrefix(signed["embed_url"].(string), h.ts.URL), "?", "/config.json?", 1), 200, ""); !strings.Contains(cfg, `"watermark":"ada@example.com"`) || !strings.Contains(cfg, `"stream":"playlist.m3u8?token=`) {
		t.Fatalf("config: %s", cfg)
	}
	h.call(c, "POST", "/v1/signed-urls", keyB, `{"video_id":"`+asset["id"].(string)+`"}`, 404)

	// A public video plays without a signature.
	h.call(c, "PATCH", assetPath, key, `{"playback_policy":"public"}`, 200)
	get(page+"/playlist.m3u8", 200, "")
	get(page+"/key", 200, "")

	// Behind the CDN every quality is listed twice, the second from the origin, so players switch by themselves when
	// the CDN fails. The first copy's segments come from the CDN, the second's from the origin.
	// The API sees the change once a ready video's cached facts expire (PlaybackTTL).
	ttl := videomod.PlaybackTTL
	videomod.PlaybackTTL = time.Second
	t.Cleanup(func() { videomod.PlaybackTTL = ttl })
	h.call(sess, "PUT", "/v1/video/delivery", "", `{"mode":"custom","custom_url":"https://cdn.customer.test"}`, 200)
	eventually(t, "playlists point at the CDN", func() bool {
		r, _ := get(page+"/720p.m3u8", 200, "")
		return regexp.MustCompile(`(?m)^https://[^\n]+/720p/1\.m4s$`).MatchString(r)
	})
	viaCDN, _ := get(page+"/playlist.m3u8", 200, "")
	if n := strings.Count(viaCDN, "#EXT-X-STREAM-INF"); n < 2 || n%2 != 0 || strings.Count(viaCDN, "via=origin") != n/2 {
		t.Fatalf("the master doesn't list each quality twice:\n%s", viaCDN)
	}
	if backup, _ := get(page+"/720p.m3u8?via=origin", 200, ""); !regexp.MustCompile(`(?m)^http://[^\n]+/720p/1\.m4s$`).MatchString(backup) {
		t.Fatalf("the backup copy doesn't read from the origin:\n%s", backup)
	}
	h.call(sess, "PUT", "/v1/video/delivery", "", `{"mode":"origin"}`, 200)
	eventually(t, "playlists back on the origin", func() bool {
		m, _ := get(page+"/playlist.m3u8", 200, "")
		return !strings.Contains(m, "via=origin")
	})
	h.call(c, "PATCH", assetPath, keyB, `{"playback_policy":"signed"}`, 404)
	h.call(c, "POST", "/v1/signing-keys", keyB, "", 201)
	if ids := h.call(c, "GET", "/v1/signing-keys", keyB, "", 200)["data"].([]any); len(ids) != 1 {
		t.Fatalf("tenant B sees %d signing keys", len(ids))
	}
	h.call(c, "DELETE", "/v1/signing-keys/"+kid, keyB, "", 404)
	h.call(c, "PATCH", assetPath, key, `{"playback_policy":"signed"}`, 200)
	get(page+"/playlist.m3u8", 403, "token_required")

	// Revoking the signing key kills every signature it made.
	h.call(c, "DELETE", "/v1/signing-keys/"+kid, key, "", 204)
	get(sign(sig, "playlist.m3u8"), 403, "token_invalid")

	// An asset still processing is not playable yet.
	waiting := h.call(c, "POST", "/v1/uploads", key, "", 201)
	w := h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+waiting["id"].(string)+`","playback_policy":"public"}`, 201)
	get(h.playPath(w)+"/playlist.m3u8", 404, "asset_not_ready")
	h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+waiting["id"].(string)+`","playback_policy":"private"}`, 400)
}
