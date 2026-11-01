package e2e

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"

	"github.com/ulkanetworks/ulka-vms/core"
)

// The origin reads the private bucket with the server's key, serves only segments, and meters each one.
func TestOriginServesSegmentsFromAPrivateBucket(t *testing.T) {
	h := newHarness(t)
	prefix := uuid.NewString() + "/" + uuid.NewString()
	segment := bytes.Repeat([]byte("segment!"), 512)
	for key, body := range map[string][]byte{prefix + "/360p/1.m4s": segment, prefix + "/360p/init.mp4": []byte("init"), prefix + "/source": []byte("the original")} {
		path := filepath.Join(t.TempDir(), filepath.Base(key)+".m4s")
		os.WriteFile(path, body, 0o644)
		if err := h.store.PutFile(t.Context(), key, path); err != nil {
			t.Fatal(err)
		}
	}
	do := func(method, path string, header http.Header) (*http.Response, []byte) {
		req, _ := http.NewRequest(method, h.origin.URL+path, nil)
		for k, v := range header {
			req.Header[k] = v
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res, b
	}

	res, body := do("GET", "/s/"+prefix+"/360p/1.m4s", http.Header{"X-Forwarded-For": {"203.0.113.9"}})
	if res.StatusCode != 200 || !bytes.Equal(body, segment) || res.Header.Get("Access-Control-Allow-Origin") != "*" ||
		res.Header.Get("Cache-Control") != "public, max-age=31536000" || res.Header.Get("Content-Type") != "video/iso.segment" {
		t.Fatalf("segment: %d %v (%d bytes)", res.StatusCode, res.Header, len(body))
	}
	if res, body := do("GET", "/s/"+prefix+"/360p/1.m4s", http.Header{"Range": {"bytes=0-7"}}); res.StatusCode != 206 || string(body) != "segment!" || res.Header.Get("Content-Range") == "" {
		t.Fatalf("range: %d %q %v", res.StatusCode, body, res.Header)
	}
	if res, body := do("HEAD", "/s/"+prefix+"/360p/init.mp4", nil); res.StatusCode != 200 || len(body) != 0 || res.Header.Get("Content-Length") != "4" {
		t.Fatalf("head: %d %v", res.StatusCode, res.Header)
	}
	for _, c := range []struct {
		method, path string
		want         int
	}{
		{"GET", "/s/" + prefix + "/360p/2.m4s", 404},  // not written
		{"GET", "/s/" + prefix + "/source", 404},      // the bucket's other files stay private
		{"GET", "/s/" + prefix + "/../source", 404},   // no way out of the segment pattern
		{"GET", "/", 404},                             // nothing else
		{"POST", "/s/" + prefix + "/360p/1.m4s", 405}, // read only
	} {
		if res, _ := do(c.method, c.path, nil); res.StatusCode != c.want || res.Header.Get("Cache-Control") != "" {
			t.Errorf("%s %s: %d %q, want %d and no caching", c.method, c.path, res.StatusCode, res.Header.Get("Cache-Control"), c.want)
		}
	}

	// Metered: the viewer's address from the trusted proxy, and the bytes sent.
	eventually(t, "segment metered", func() bool {
		var row struct {
			Addr  string `json:"client_addr"`
			Bytes int64  `json:"body_bytes"`
		}
		err := core.ClickHouseQuery(t.Context(), h.cfg.ClickHouseURL, `SELECT toString(client_addr) AS client_addr, body_bytes FROM origin_access_logs
			WHERE uri = {u:String} AND status = 200 AND method = 'GET' FORMAT JSONEachRow`, map[string]string{"u": "/s/" + prefix + "/360p/1.m4s"},
			func(b []byte) error { return json.Unmarshal(b, &row) })
		return err == nil && row.Addr == "::ffff:203.0.113.9" && row.Bytes == int64(len(segment))
	})
}
