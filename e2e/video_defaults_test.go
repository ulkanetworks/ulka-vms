package e2e

import (
	"reflect"
	"testing"
)

// Workspace video defaults reach the libraries that follow them, and only those.
func TestVideoDefaults(t *testing.T) {
	h := newHarness(t)
	c, _ := h.signup("defaults")
	str := func(m map[string]any, k string) string { s, _ := m[k].(string); return s }
	code := func(out map[string]any) string { return out["error"].(map[string]any)["code"].(string) }

	d := h.call(c, "GET", "/v1/video/defaults", "", "", 200)
	if d["preset_template"] != "balanced" || d["mp4_downloads"] != false || d["default_playback_policy"] != "public" || len(d["allowed_domains"].([]any)) != 0 || d["player"].(map[string]any)["theme"] != "dark" {
		t.Fatalf("platform defaults: %v", d)
	}

	for body, want := range map[string]string{
		`{"default_playback_policy":"secret"}`: "invalid_library",
		`{"allowed_domains":["not a domain"]}`: "invalid_domains",
		`{"preset_template":"nonsense"}`:       "invalid_preset",
		`{"player":{"accent":"red"}}`:          "invalid_player",
	} {
		if out := h.call(c, "PUT", "/v1/video/defaults", "", body, 400); code(out) != want {
			t.Fatalf("%s: %v", body, out)
		}
	}

	all := []any{"player", "transcoding", "security"}
	a := str(h.call(c, "POST", "/v1/libraries", "", `{"name":"Follows"}`, 201), "id")
	b := str(h.call(c, "POST", "/v1/libraries", "", `{"name":"Custom"}`, 201), "id")
	if lib := h.call(c, "GET", "/v1/libraries/"+a, "", "", 200); !reflect.DeepEqual(lib["inherits"], all) {
		t.Fatalf("a new library follows every group: %v", lib["inherits"])
	}

	// Customizing through an existing endpoint drops that group only.
	lib := h.call(c, "PATCH", "/v1/libraries/"+b, "", `{"allowed_domains":["mine.example.com"]}`, 200)
	if !reflect.DeepEqual(lib["inherits"], []any{"player", "transcoding"}) {
		t.Fatalf("security should be dropped: %v", lib["inherits"])
	}
	h.call(c, "PUT", "/v1/libraries/"+b+"/player", "", `{"accent":"#112233","theme":"light","skip":5}`, 200)
	lib = h.call(c, "PUT", "/v1/libraries/"+b+"/transcoding", "", `{"template":"best"}`, 200)
	if lib["active_template"] != "best" {
		t.Fatalf("transcoding: %v", lib)
	}
	if lib = h.call(c, "GET", "/v1/libraries/"+b, "", "", 200); len(lib["inherits"].([]any)) != 0 {
		t.Fatalf("all groups should be dropped: %v", lib["inherits"])
	}

	// A change reaches the library that follows, never the customized one.
	put := `{"preset_template":"saver","mp4_downloads":true,"allowed_domains":["Shop.Example.com"],"default_playback_policy":"signed","player":{"accent":"#abcdef","theme":"light","skip":15,"speed":true}}`
	d = h.call(c, "PUT", "/v1/video/defaults", "", put, 200)
	if d["preset_template"] != "saver" || d["default_playback_policy"] != "signed" || d["allowed_domains"].([]any)[0] != "shop.example.com" || d["player"].(map[string]any)["accent"] != "#abcdef" {
		t.Fatalf("saved: %v", d)
	}
	la := h.call(c, "GET", "/v1/libraries/"+a, "", "", 200)
	if la["preset_template"] != "saver" || la["mp4_downloads"] != true || la["default_playback_policy"] != "signed" || la["allowed_domains"].([]any)[0] != "shop.example.com" {
		t.Fatalf("follower: %v", la)
	}
	if p := h.call(c, "GET", "/v1/libraries/"+a+"/player", "", "", 200); p["accent"] != "#abcdef" || p["skip"] != 15.0 {
		t.Fatalf("follower player: %v", p)
	}
	lb := h.call(c, "GET", "/v1/libraries/"+b, "", "", 200)
	if lb["preset_template"] != "best" || lb["mp4_downloads"] != false || lb["default_playback_policy"] != "public" || lb["allowed_domains"].([]any)[0] != "mine.example.com" {
		t.Fatalf("customized library changed: %v", lb)
	}
	if p := h.call(c, "GET", "/v1/libraries/"+b+"/player", "", "", 200); p["accent"] != "#112233" {
		t.Fatalf("customized player changed: %v", p)
	}

	// A partial PUT leaves the other fields; inherit:true copies the defaults back and follows again.
	h.call(c, "PUT", "/v1/video/defaults", "", `{"mp4_downloads":false}`, 200)
	lb = h.call(c, "PATCH", "/v1/libraries/"+b, "", `{"inherit":{"security":true,"player":true}}`, 200)
	if lb["default_playback_policy"] != "signed" || lb["allowed_domains"].([]any)[0] != "shop.example.com" || lb["preset_template"] != "best" ||
		!reflect.DeepEqual(lb["inherits"], []any{"player", "security"}) {
		t.Fatalf("inherit true: %v", lb)
	}
	if p := h.call(c, "GET", "/v1/libraries/"+b+"/player", "", "", 200); p["accent"] != "#abcdef" {
		t.Fatalf("player after inherit: %v", p)
	}
	// inherit:false only stops following; the values stay.
	lb = h.call(c, "PATCH", "/v1/libraries/"+b, "", `{"inherit":{"security":false}}`, 200)
	if lb["default_playback_policy"] != "signed" || !reflect.DeepEqual(lb["inherits"], []any{"player"}) {
		t.Fatalf("inherit false: %v", lb)
	}

	// A new library copies the current defaults.
	c2 := str(h.call(c, "POST", "/v1/libraries", "", `{"name":"Later"}`, 201), "id")
	if lc := h.call(c, "GET", "/v1/libraries/"+c2, "", "", 200); lc["preset_template"] != "saver" || lc["default_playback_policy"] != "signed" || !reflect.DeepEqual(lc["inherits"], all) {
		t.Fatalf("new library: %v", lc)
	}

	// Another workspace has its own defaults.
	oc, _ := h.signup("defaults-elsewhere")
	if od := h.call(oc, "GET", "/v1/video/defaults", "", "", 200); od["preset_template"] != "balanced" || od["default_playback_policy"] != "public" {
		t.Fatalf("other workspace sees ours: %v", od)
	}
	h.call(oc, "PUT", "/v1/video/defaults", "", `{"default_playback_policy":"public","mp4_downloads":true}`, 200)
	if d = h.call(c, "GET", "/v1/video/defaults", "", "", 200); d["mp4_downloads"] != false || d["default_playback_policy"] != "signed" {
		t.Fatalf("other workspace changed ours: %v", d)
	}
}
