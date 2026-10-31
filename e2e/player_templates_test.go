package e2e

import (
	"encoding/json"
	"io"
	"testing"
)

// TestPlayerTemplates: the API lists the templates, a library can save one's controls, and ?template= on an embed
// swaps the library's controls for the template's while keeping its look.
func TestPlayerTemplates(t *testing.T) {
	h := newHarness(t)
	_, key := h.signup("templates")
	c := h.client()
	list := h.call(c, "GET", "/v1/player/templates", key, "", 200)["data"].([]any)
	if len(list) != 4 || list[0].(map[string]any)["key"] != "standard" {
		t.Fatalf("templates: %v", list)
	}
	up := h.call(c, "POST", "/v1/uploads", key, "", 201)
	asset := h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+up["id"].(string)+`","playback_policy":"public"}`, 201)
	lib := asset["library_id"].(string)
	h.call(c, "PUT", "/v1/libraries/"+lib+"/player", key, `{"accent":"#0f766e","theme":"light","skip":10}`, 200)

	config := func(query string, want int) map[string]any {
		t.Helper()
		res, err := h.ts.Client().Get(h.ts.URL + h.playPath(asset) + "/config.json" + query)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		var out map[string]any
		if res.StatusCode != want || json.Unmarshal(b, &out) != nil {
			t.Fatalf("config%s: %d %s", query, res.StatusCode, b)
		}
		return out
	}
	if s := config("", 200)["settings"].(map[string]any); s["controls"] != true || s["autoplay"] != false {
		t.Fatalf("library settings: %v", s)
	}
	s := config("?template=background", 200)["settings"].(map[string]any)
	if s["controls"] != false || s["autoplay"] != true || s["muted"] != true || s["loop"] != true || s["accent"] != "#0f766e" || s["theme"] != "light" {
		t.Fatalf("background template: %v", s)
	}
	if out := config("?template=nope", 400); out["error"].(map[string]any)["code"] != "invalid_template" {
		t.Fatalf("unknown template: %v", out)
	}

	// Saving a template's settings into the library makes it the default for every video there.
	h.call(c, "PUT", "/v1/libraries/"+lib+"/player", key, `{"accent":"#0f766e","theme":"light","controls":false,"autoplay":true,"muted":true,"loop":true,"skip":0}`, 200)
	if got := h.call(c, "GET", "/v1/libraries/"+lib+"/player", key, "", 200); got["controls"] != false || got["autoplay"] != true {
		t.Fatalf("saved: %v", got)
	}
}
