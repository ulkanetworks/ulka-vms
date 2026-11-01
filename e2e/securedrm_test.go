package e2e

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ulkanetworks/ulka-vms/app"
	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/securedrm"
	"github.com/ulkanetworks/ulka-vms/transcoder"
)

// fakeSecureDRM answers SecureDRM's server API and player route the way the real one does.
type fakeSecureDRM struct {
	*httptest.Server
	apiKey string
	secret []byte
	mu     sync.Mutex
	keys   map[string][2][]byte
}

func newFakeSecureDRM(t *testing.T) *fakeSecureDRM {
	f := &fakeSecureDRM{apiKey: "sdrm_test_" + strings.Repeat("k", 32), secret: make([]byte, 32), keys: map[string][2][]byte{}}
	rand.Read(f.secret)
	mux := http.NewServeMux()
	auth := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer "+f.apiKey {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			h(w, r)
		}
	}
	answer := func(w http.ResponseWriter, id string) {
		k, ok := f.keys[id]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"content_id": id, "key": hex.EncodeToString(k[0]), "iv": hex.EncodeToString(k[1])})
	}
	mux.HandleFunc("POST /v1/keys", auth(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			ContentID string `json:"content_id"`
		}
		json.NewDecoder(r.Body).Decode(&in)
		f.mu.Lock()
		defer f.mu.Unlock()
		if _, ok := f.keys[in.ContentID]; !ok {
			k, iv := make([]byte, 16), make([]byte, 16)
			rand.Read(k)
			rand.Read(iv)
			f.keys[in.ContentID] = [2][]byte{k, iv}
		}
		answer(w, in.ContentID)
	}))
	mux.HandleFunc("GET /v1/keys/{id}", auth(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		answer(w, r.PathValue("id"))
	}))
	mux.HandleFunc("DELETE /v1/keys/{id}", auth(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if _, ok := f.keys[r.PathValue("id")]; !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		delete(f.keys, r.PathValue("id"))
		w.WriteHeader(http.StatusNoContent)
	}))
	mux.HandleFunc("GET /v1/key/{id}", func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(r.URL.Query().Get("token"), ".")
		var c struct {
			Sub string `json:"sub"`
			Exp int64  `json:"exp"`
		}
		mac := hmac.New(sha256.New, f.secret)
		mac.Write([]byte(strings.Join(parts[:min(2, len(parts))], ".")))
		payload, _ := base64.RawURLEncoding.DecodeString(parts[min(1, len(parts)-1)])
		sig, _ := base64.RawURLEncoding.DecodeString(parts[len(parts)-1])
		if len(parts) != 3 || !hmac.Equal(mac.Sum(nil), sig) || json.Unmarshal(payload, &c) != nil || c.Sub != r.PathValue("id") || time.Now().Unix() >= c.Exp {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Write(f.keys[c.Sub][0])
	})
	f.Server = httptest.NewServer(mux)
	t.Cleanup(f.Close)
	return f
}

func (f *fakeSecureDRM) key(id string) ([2][]byte, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	k, ok := f.keys[id]
	return k, ok
}

func TestSecureDRMKeys(t *testing.T) {
	drm := newFakeSecureDRM(t)
	h := newHarnessWith(t, func(c *app.Config) {
		c.Keys = &securedrm.Client{URL: drm.URL, APIKey: drm.apiKey, TokenKid: "testkid1", TokenSecret: drm.secret, Client: drm.Client()}
	})
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
	_, apiKey := h.signup("securedrm")
	c := h.client()
	up := h.call(c, "POST", "/v1/uploads", apiKey, "", 201)
	h.sendUpload(up, body, http.StatusOK)
	asset := h.call(c, "POST", "/v1/assets", apiKey, `{"upload_id":"`+up["id"].(string)+`"}`, 201)
	id := asset["id"].(string)
	for start := time.Now(); asset["status"] != "complete" && time.Since(start) < time.Minute; time.Sleep(300 * time.Millisecond) {
		asset = h.call(c, "GET", "/v1/assets/"+id, apiKey, "", 200)
	}
	if asset["status"] != "complete" {
		t.Fatalf("asset: %v", asset)
	}

	// The key is SecureDRM's: the server keeps only the IV.
	k, ok := drm.key(id)
	if !ok {
		t.Fatal("SecureDRM was never asked for the video's key")
	}
	var tid pgtype.UUID
	tid.Scan(h.call(c, "GET", "/v1/me", apiKey, "", 200)["tenant"].(map[string]any)["id"].(string))
	var stored, iv []byte
	err = core.InTenant(t.Context(), h.pool, tid, func(q core.TenantTx) error {
		return q.Tx.QueryRow(t.Context(), "SELECT encryption_key, encryption_iv FROM assets WHERE id = $1", id).Scan(&stored, &iv)
	})
	if err != nil || stored != nil || !hmac.Equal(iv, k[1]) {
		t.Fatalf("stored key %x, iv %x (err %v); want no key and SecureDRM's iv %x", stored, iv, err, k[1])
	}

	get := func(u string) (int, []byte) {
		res, err := h.ts.Client().Get(u)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, b
	}
	page := h.ts.URL + h.playPath(asset)
	status, rendition := get(page + "/360p.m3u8")
	m := regexp.MustCompile(`#EXT-X-KEY:[^\n]*URI="([^"]+)"`).FindSubmatch(rendition)
	if status != 200 || m == nil || !strings.HasPrefix(string(m[1]), drm.URL+"/v1/key/"+id+"?token=") {
		t.Fatalf("the playlist's key isn't SecureDRM's player address: %d\n%s\n%v", status, rendition, asset["renditions"])
	}
	if status, key := get(string(m[1])); status != 200 || !hmac.Equal(key, k[0]) {
		t.Fatalf("SecureDRM refused the token the server signed: %d", status)
	}
	if status, _ := get(page + "/key"); status != 404 {
		t.Fatalf("the player host still serves the key itself: %d", status)
	}
	// Segments decrypt with SecureDRM's key: the encoder used it.
	seg := regexp.MustCompile(`(?m)^http[^\n]+/360p/1\.m4s$`).Find(rendition)
	_, piece := get(string(seg))
	if clear, err := transcoder.DecryptSegment(piece, k[0], k[1]); err != nil || !strings.Contains(string(clear[:min(len(clear), 1024)]), "moof") {
		t.Fatalf("segment doesn't decrypt with SecureDRM's key: %v", err)
	}

	h.call(c, "DELETE", "/v1/assets/"+id, apiKey, "", 204)
	for start := time.Now(); time.Since(start) < 30*time.Second; time.Sleep(300 * time.Millisecond) {
		if _, ok := drm.key(id); !ok {
			return
		}
	}
	t.Fatal("deleting the video left its key in SecureDRM")
}
