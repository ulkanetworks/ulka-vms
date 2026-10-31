package e2e

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ulkanetworks/ulka-vms/app"
	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/video"
)

func TestVideoDelivery(t *testing.T) {
	h := newHarness(t)
	c, key := h.signup("delivery")

	d := h.call(c, "GET", "/v1/video/delivery", "", "", 200)
	if d["mode"] != "origin" || d["cdn_distribution"] != nil || d["serving"] != h.cfg.OriginURL || strings.Join(strs(d["modes"]), ",") != "origin,custom" {
		t.Fatalf("default delivery: %v", d)
	}
	h.call(c, "PUT", "/v1/video/delivery", "", `{"mode":"custom","custom_url":"http://cdn.customer.test"}`, 400) // https only
	h.call(c, "PUT", "/v1/video/delivery", "", `{"mode":"custom","custom_url":"https://cdn.customer.test/path"}`, 400)
	h.call(c, "PUT", "/v1/video/delivery", "", `{"mode":"sometimes"}`, 400)
	h.call(c, "PUT", "/v1/video/delivery", "", `{"mode":"ulka_cdn"}`, 400)         // only with a managed CDN
	h.call(h.client(), "PUT", "/v1/video/delivery", key, `{"mode":"origin"}`, 200) // API keys with video:write choose delivery too

	h.call(c, "PUT", "/v1/video/delivery", "", `{"mode":"custom","custom_url":"https://cdn.customer.test","provider":"maxcdn"}`, 400)
	d = h.call(c, "PUT", "/v1/video/delivery", "", `{"mode":"custom","custom_url":"https://CDN.Customer.test/","provider":"bunny"}`, 200)
	if !strings.HasPrefix(d["serving"].(string), "https://cdn.customer.test") || d["provider"] != "bunny" {
		t.Fatalf("custom delivery serves %v", d["serving"])
	}
	// Ulka CDN is a provider like any other: a distribution made at Ulka, pulling from this server.
	d = h.call(c, "PUT", "/v1/video/delivery", "", `{"mode":"custom","custom_url":"https://v1abc.ulkacdn.net","provider":"ulka"}`, 200)
	if d["provider"] != "ulka" || !strings.HasPrefix(d["serving"].(string), "https://v1abc.ulkacdn.net") {
		t.Fatalf("Ulka CDN as a provider: %v", d)
	}
	if st := h.call(c, "GET", "/v1/video/stats", key, "", 200); st["total"].(float64) != 0 {
		t.Fatalf("stats: %v", st)
	}
}

// fakeManaged is a managed CDN whose distributions go live when told.
type fakeManaged struct {
	mu      sync.Mutex
	made    int
	active  bool
	deleted bool
}

func (f *fakeManaged) Create(context.Context, core.TenantTx, string) (pgtype.UUID, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.made++
	return pgtype.UUID{Bytes: [16]byte{1}, Valid: true}, nil
}

func (f *fakeManaged) State(context.Context, core.TenantTx, pgtype.UUID) (video.Distribution, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return video.Distribution{Name: "Video delivery", Hostname: "v1abc.ulkacdn.test", Active: f.active}, !f.deleted, nil
}

// An application built on ulka-vms that runs its own CDN offers it in place of the workspace's own.
func TestManagedDelivery(t *testing.T) {
	managed := &fakeManaged{}
	h := newHarnessWithExt(t, app.Extension{Video: func(*core.Deps) video.Options { return video.Options{Managed: managed} }})
	c, _ := h.signup("managed")

	if d := h.call(c, "GET", "/v1/video/delivery", "", "", 200); strings.Join(strs(d["modes"]), ",") != "origin,ulka_cdn" {
		t.Fatalf("modes: %v", d["modes"])
	}
	h.call(c, "PUT", "/v1/video/delivery", "", `{"mode":"custom","custom_url":"https://cdn.customer.test"}`, 400)
	d := h.call(c, "PUT", "/v1/video/delivery", "", `{"mode":"ulka_cdn"}`, 200)
	if d["serving"] != h.cfg.OriginURL || d["cdn_distribution"].(map[string]any)["hostname"] != "v1abc.ulkacdn.test" {
		t.Fatalf("until live, segments come from the origin: %v", d)
	}
	managed.mu.Lock()
	managed.active = true
	managed.mu.Unlock()
	if d := h.call(c, "GET", "/v1/video/delivery", "", "", 200); !strings.HasPrefix(d["serving"].(string), "https://v1abc.ulkacdn.test") {
		t.Fatalf("once live: %v", d)
	}
	// Switching away and back reuses the same distribution rather than making another.
	h.call(c, "PUT", "/v1/video/delivery", "", `{"mode":"origin"}`, 200)
	h.call(c, "PUT", "/v1/video/delivery", "", `{"mode":"ulka_cdn"}`, 200)
	if managed.made != 1 {
		t.Fatalf("distributions made: %d", managed.made)
	}
	// A distribution deleted elsewhere falls back to the origin rather than breaking playback.
	managed.mu.Lock()
	managed.deleted = true
	managed.mu.Unlock()
	if d := h.call(c, "GET", "/v1/video/delivery", "", "", 200); d["serving"] != h.cfg.OriginURL || d["cdn_distribution"] != nil {
		t.Fatalf("after deletion: %v", d)
	}
}

func strs(v any) []string {
	var out []string
	for _, s := range v.([]any) {
		out = append(out, s.(string))
	}
	return out
}
