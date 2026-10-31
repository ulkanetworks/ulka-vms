package e2e

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

// A file sent to upload_url in parts with Content-Range: a part that skips ahead is refused, a part whose connection
// drops keeps what arrived, and GET says where to carry on, until the last part completes the file.
func TestResumableUpload(t *testing.T) {
	h := newHarness(t)
	c, key := h.signup("resume")
	up := h.call(c, "POST", "/v1/uploads", key, "", 201)
	addr := up["upload_url"].(string)
	file := bytes.Repeat([]byte("ulka!"), 3<<20) // 15 MiB: several storage parts
	total := len(file)

	put := func(body io.Reader, length int64, cr string, want int) map[string]any {
		t.Helper()
		req, _ := http.NewRequest("PUT", addr, body)
		req.ContentLength = length
		if cr != "" {
			req.Header.Set("Content-Range", cr)
		}
		res, err := h.ts.Client().Do(req)
		if err != nil {
			if want == 0 {
				return nil // the connection was cut, as intended
			}
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]any
		json.NewDecoder(res.Body).Decode(&out)
		if want != 0 && res.StatusCode != want {
			t.Fatalf("PUT %s: %d %v, want %d", cr, res.StatusCode, out, want)
		}
		return out
	}
	part := func(from, to int) string { return fmt.Sprintf("bytes %d-%d/%d", from, to-1, total) }
	status := func() map[string]any {
		t.Helper()
		res, err := h.ts.Client().Get(addr)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]any
		json.NewDecoder(res.Body).Decode(&out)
		return out
	}

	if got := status(); got["received"] != 0.0 || got["size"] != nil || got["complete"] != false {
		t.Fatalf("before any part: %v", got)
	}
	first := 6 << 20
	if got := put(bytes.NewReader(file[:first]), int64(first), part(0, first), 200); got["received"] != float64(first) || got["complete"] != false {
		t.Fatalf("first part: %v", got)
	}
	// Skipping ahead, or a range that doesn't add up, is refused and changes nothing.
	if got := put(bytes.NewReader(file[first+10:]), int64(total-first-10), part(first+10, total), 409); got["error"].(map[string]any)["code"] != "upload_offset_mismatch" {
		t.Fatalf("skipped ahead: %v", got)
	}
	put(bytes.NewReader(file[:10]), 10, "bytes 0-20/"+fmt.Sprint(total), 400)

	// The next part's connection drops after 1 MiB: what arrived is kept, and GET says so.
	cut := io.MultiReader(bytes.NewReader(file[first:first+1<<20]), cutOff{})
	put(cut, int64(total-first), part(first, total), 0)
	at := int(status()["received"].(float64))
	if at < first || at > first+1<<20 {
		t.Fatalf("after the break the upload reports %d received, want %d to %d", at, first, first+1<<20)
	}
	if got := put(bytes.NewReader(file[at:]), int64(total-at), part(at, total), 200); got["complete"] != true || got["received"] != float64(total) {
		t.Fatalf("last part: %v", got)
	}
	if got := status(); got["complete"] != true || got["size"] != float64(total) {
		t.Fatalf("after the last part: %v", got)
	}
	put(bytes.NewReader(file[:10]), 10, "", 409) // a finished upload takes nothing more

	asset := h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+up["id"].(string)+`"}`, 201)
	if asset["status"] == "waiting" {
		t.Fatalf("the finished upload isn't seen: %v", asset["status"])
	}

	// A browser on another website may send parts: the preflight allows Content-Range.
	req, _ := http.NewRequest("OPTIONS", addr, nil)
	res, err := h.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if !strings.Contains(res.Header.Get("Access-Control-Allow-Headers"), "Content-Range") {
		t.Fatalf("preflight: %v", res.Header)
	}
}
