package e2e

import (
	"testing"
)

// TestAPIKeysReachTheConsoleFeatures: what the console does with libraries, folders, presets, the trash, player and
// delivery settings works with an API key too, within the key's scopes.
func TestAPIKeysReachTheConsoleFeatures(t *testing.T) {
	h := newHarness(t)
	console, write := h.signup("keys")
	key := func(scopes string) string {
		return h.call(console, "POST", "/v1/api-keys", "", `{"name":"k","scopes":[`+scopes+`]}`, 201)["key"].(string)
	}
	read, hooksOnly := key(`"video:read"`), key(`"webhooks:write"`)
	c := h.ts.Client() // no cookies: only the key authenticates

	lib := h.call(c, "POST", "/v1/libraries", write, `{"name":"From the API","description":"made with a key"}`, 201)["id"].(string)
	h.call(c, "GET", "/v1/libraries/"+lib, read, "", 200)
	h.call(c, "POST", "/v1/libraries", read, `{"name":"Not allowed"}`, 403)
	h.call(c, "GET", "/v1/libraries/"+lib, hooksOnly, "", 403)
	h.call(c, "PATCH", "/v1/libraries/"+lib, write, `{"mp4_downloads":true,"allowed_domains":["example.com"]}`, 200)

	folder := h.call(c, "POST", "/v1/libraries/"+lib+"/folders", write, `{"name":"Lessons"}`, 201)["id"].(string)
	h.call(c, "PATCH", "/v1/folders/"+folder, write, `{"name":"Lessons 2026"}`, 204)

	preset := h.call(c, "POST", "/v1/libraries/"+lib+"/presets", write, `{"name":"Small","heights":[360,480],"quality":"fast"}`, 201)["id"].(string)
	h.call(c, "PUT", "/v1/libraries/"+lib+"/transcoding", write, `{"preset_id":"`+preset+`"}`, 200)
	if got := h.call(c, "GET", "/v1/libraries/"+lib+"/transcoding", read, "", 200)["active_preset"]; got != preset {
		t.Fatalf("active preset %v", got)
	}

	h.call(c, "PUT", "/v1/libraries/"+lib+"/player", write, `{"accent":"#0f766e","theme":"light","skip":5}`, 200)
	if got := h.call(c, "GET", "/v1/libraries/"+lib+"/player", read, "", 200)["accent"]; got != "#0f766e" {
		t.Fatalf("player accent %v", got)
	}
	h.call(c, "PUT", "/v1/libraries/"+lib+"/player", read, `{"accent":"#000000"}`, 403)

	h.call(c, "GET", "/v1/video/defaults", read, "", 200)
	h.call(c, "PUT", "/v1/video/defaults", write, `{"mp4_downloads":true}`, 200)
	h.call(c, "PUT", "/v1/video/delivery", write, `{"mode":"origin"}`, 200)

	video := h.call(c, "POST", "/v1/assets", write, `{"input_url":"https://example.com/v.mp4","library_id":"`+lib+`"}`, 201)["id"].(string)
	h.call(c, "POST", "/v1/assets/move", write, `{"ids":["`+video+`"],"library_id":"`+lib+`","folder_id":"`+folder+`"}`, 204)
	h.call(c, "POST", "/v1/assets/trash", read, `{"ids":["`+video+`"]}`, 403)
	h.call(c, "POST", "/v1/assets/trash", write, `{"ids":["`+video+`"]}`, 204)
	h.call(c, "POST", "/v1/assets/restore", write, `{"ids":["`+video+`"]}`, 204)
	h.call(c, "POST", "/v1/assets/trash", write, `{"ids":["`+video+`"]}`, 204)
	h.call(c, "POST", "/v1/assets/purge", write, `{"ids":["`+video+`"]}`, 204)

	h.call(c, "DELETE", "/v1/folders/"+folder, write, "", 204)
	h.call(c, "PUT", "/v1/libraries/"+lib+"/transcoding", write, `{"template":"balanced"}`, 200)
	h.call(c, "DELETE", "/v1/presets/"+preset, write, "", 204)
	h.call(c, "DELETE", "/v1/libraries/"+lib, write, "", 204)
}
