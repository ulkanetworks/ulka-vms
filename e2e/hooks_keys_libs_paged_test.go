package e2e

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/webhooks"
)

// pageIDs reads a cursor list two rows at a time and returns every id in order.
func pageIDs(t *testing.T, h *harness, c *http.Client, path, key string) []string {
	t.Helper()
	var ids []string
	cursor := ""
	for range 20 {
		sep := "?"
		if strings.Contains(path, "?") {
			sep = "&"
		}
		out := h.call(c, "GET", path+sep+"limit=2&cursor="+url.QueryEscape(cursor), key, "", 200)
		rows := out["data"].([]any)
		if len(rows) > 2 {
			t.Fatalf("%s: page of %d rows", path, len(rows))
		}
		for _, r := range rows {
			ids = append(ids, r.(map[string]any)["id"].(string))
		}
		if cursor = out["next_cursor"].(string); cursor == "" {
			return ids
		}
	}
	t.Fatalf("%s: never reached the last page", path)
	return nil
}

// wantTotal checks a list's total: every row matching the request, whatever the page size or cursor.
func wantTotal(t *testing.T, h *harness, c *http.Client, path, key string, want float64) {
	t.Helper()
	if got := h.call(c, "GET", path, key, "", 200)["total"]; got != want {
		t.Errorf("%s: total %v, want %v", path, got, want)
	}
}

func TestWebhookEndpointsPaged(t *testing.T) {
	h := newHarness(t)
	webhooks.CheckHost = func(context.Context, string) error { return nil }
	t.Cleanup(func() { webhooks.CheckHost = core.CheckPublicHost })
	c, key := h.signup("hookpage")
	_, other := h.signup("hookother")
	var made []string
	for i := range 5 {
		made = append(made, h.call(c, "POST", "/v1/webhook-endpoints", key, fmt.Sprintf(`{"url":"https://example.com/page-%d"}`, i), 201)["id"].(string))
	}
	h.call(c, "POST", "/v1/webhook-endpoints", other, `{"url":"https://example.com/page-theirs"}`, 201)
	got := pageIDs(t, h, c, "/v1/webhook-endpoints", key)
	if len(got) != 5 {
		t.Fatalf("paged %d endpoints, want 5: %v", len(got), got)
	}
	for i, id := range got { // newest first
		if id != made[4-i] {
			t.Fatalf("row %d is %s, want %s", i, id, made[4-i])
		}
	}
	if q := h.call(c, "GET", "/v1/webhook-endpoints?q=page-3", key, "", 200)["data"].([]any); len(q) != 1 || q[0].(map[string]any)["id"] != made[3] {
		t.Fatalf("search page-3: %v", q)
	}
	if q := h.call(c, "GET", "/v1/webhook-endpoints?q=theirs", key, "", 200)["data"].([]any); len(q) != 0 {
		t.Fatalf("saw another workspace's endpoint: %v", q)
	}
	wantTotal(t, h, c, "/v1/webhook-endpoints?limit=2", key, 5)
	wantTotal(t, h, c, "/v1/webhook-endpoints?q=page-3", key, 1)
	h.call(c, "GET", "/v1/webhook-endpoints?limit=0", key, "", 400)
	h.call(c, "GET", "/v1/webhook-endpoints?cursor=nope", key, "", 400)
}

func TestSigningKeysPaged(t *testing.T) {
	h := newHarness(t)
	c, key := h.signup("keypage")
	var made []string
	for range 5 {
		made = append(made, h.call(c, "POST", "/v1/signing-keys", key, "", 201)["id"].(string))
	}
	got := pageIDs(t, h, c, "/v1/signing-keys", key)
	if len(got) != 5 {
		t.Fatalf("paged %d keys, want 5", len(got))
	}
	for i, id := range got {
		if id != made[4-i] {
			t.Fatalf("row %d is %s, want %s", i, id, made[4-i])
		}
	}
	if q := h.call(c, "GET", "/v1/signing-keys?q="+made[2], key, "", 200)["data"].([]any); len(q) != 1 || q[0].(map[string]any)["id"] != made[2] {
		t.Fatalf("search by id: %v", q)
	}
	wantTotal(t, h, c, "/v1/signing-keys?limit=2", key, 5)
	wantTotal(t, h, c, "/v1/signing-keys?q=zzzz", key, 0)
	if q := h.call(c, "GET", "/v1/signing-keys?q=zzzz", key, "", 200)["data"].([]any); len(q) != 0 {
		t.Fatalf("search zzzz: %v", q)
	}
}

func TestLibrariesPaged(t *testing.T) {
	h := newHarness(t)
	c, key := h.signup("libpage")
	for i := range 4 {
		h.call(c, "POST", "/v1/libraries", "", fmt.Sprintf(`{"name":"Shelf %d","description":"row %d"}`, i, i), 201)
	}
	if got := pageIDs(t, h, c, "/v1/libraries", key); len(got) != 5 { // Main plus four
		t.Fatalf("paged %d libraries, want 5", len(got))
	}
	wantTotal(t, h, c, "/v1/libraries?limit=2", key, 5)
	wantTotal(t, h, c, "/v1/libraries?q=shelf", key, 4)
	if q := h.call(c, "GET", "/v1/libraries?q=shelf%202", key, "", 200)["data"].([]any); len(q) != 1 || q[0].(map[string]any)["name"] != "Shelf 2" {
		t.Fatalf("search by name: %v", q)
	}
	if q := h.call(c, "GET", "/v1/libraries?q=row%203", key, "", 200)["data"].([]any); len(q) != 1 {
		t.Fatalf("search by description: %v", q)
	}
}
