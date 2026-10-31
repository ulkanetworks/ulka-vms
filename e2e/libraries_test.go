package e2e

import (
	"net/http"
	"testing"
)

func TestLibraries(t *testing.T) {
	h := newHarness(t)
	c, key := h.signup("lib")
	_, other := h.signup("other")
	code := func(out map[string]any) string { return out["error"].(map[string]any)["code"].(string) }
	str := func(m map[string]any, k string) string { s, _ := m[k].(string); return s }
	list := func(path string) []any { t.Helper(); return h.call(c, "GET", path, key, "", 200)["data"].([]any) }
	ids := func(items []any) map[string]bool {
		got := map[string]bool{}
		for _, a := range items {
			got[str(a.(map[string]any), "id")] = true
		}
		return got
	}

	// Every workspace has a main library from the start.
	libs := list("/v1/libraries")
	main := libs[0].(map[string]any)
	if len(libs) != 1 || main["name"] != "Main" || main["is_default"] != true || main["videos"] != 0.0 {
		t.Fatalf("libraries: %v", libs)
	}
	mainID := str(main, "id")

	// Create, and refuse a name already used (any case) or a bad one.
	courses := h.call(c, "POST", "/v1/libraries", "", `{"name":"Courses","description":"Recorded classes"}`, 201)
	cid := str(courses, "id")
	if out := h.call(c, "POST", "/v1/libraries", "", `{"name":"courses"}`, 409); code(out) != "library_name_taken" {
		t.Fatalf("duplicate: %v", out)
	}
	if out := h.call(c, "POST", "/v1/libraries", "", `{"name":"  "}`, 400); code(out) != "invalid_library" {
		t.Fatalf("blank: %v", out)
	}
	h.call(h.client(), "POST", "/v1/libraries", key, `{"name":"By key"}`, 201) // API keys with video:write manage libraries too

	// Folders nest; a name is unique within its parent; a folder can't move into itself or below itself.
	a := h.call(c, "POST", "/v1/libraries/"+cid+"/folders", "", `{"name":"Admission"}`, 201)
	aid := str(a, "id")
	b := h.call(c, "POST", "/v1/libraries/"+cid+"/folders", "", `{"name":"Week 1","parent_id":"`+aid+`"}`, 201)
	bid := str(b, "id")
	if out := h.call(c, "POST", "/v1/libraries/"+cid+"/folders", "", `{"name":"week 1","parent_id":"`+aid+`"}`, 409); code(out) != "folder_name_taken" {
		t.Fatalf("duplicate folder: %v", out)
	}
	h.call(c, "POST", "/v1/libraries/"+cid+"/folders", "", `{"name":"Week 1"}`, 201) // same name, another parent
	if out := h.call(c, "PATCH", "/v1/folders/"+aid, "", `{"parent_id":"`+bid+`"}`, 400); code(out) != "invalid_move" {
		t.Fatalf("a folder moved below itself: %v", out)
	}
	if out := h.call(c, "POST", "/v1/libraries/"+mainID+"/folders", "", `{"name":"Cross","parent_id":"`+aid+`"}`, 400); code(out) != "invalid_move" {
		t.Fatalf("a parent from another library: %v", out)
	}
	h.call(c, "PATCH", "/v1/folders/"+bid, "", `{"name":"Week one"}`, 204)
	if folders := list("/v1/libraries/" + cid + "/folders"); len(folders) != 3 {
		t.Fatalf("folders: %v", folders)
	}

	// A video is made inside a folder, with a title, and found by folder, library and title.
	upload := func() string { return str(h.call(c, "POST", "/v1/uploads", key, "", 201), "id") }
	asset := h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+upload()+`","library_id":"`+cid+`","folder_id":"`+bid+`","title":"Intro to algebra","playback_policy":"public"}`, 201)
	vid := str(asset, "id")
	if str(asset, "library_id") != cid || str(asset, "folder_id") != bid || asset["title"] != "Intro to algebra" {
		t.Fatalf("asset placement: %v", asset)
	}
	page := h.playPath(asset)
	if n := len(list("/v1/assets?library_id=" + cid + "&folder_id=" + bid)); n != 1 {
		t.Fatalf("in its folder: %d", n)
	}
	if n := len(list("/v1/assets?library_id=" + cid + "&folder_id=root")); n != 0 {
		t.Fatalf("in Home: %d", n)
	}
	if n := len(list("/v1/assets?library_id=" + mainID)); n != 0 {
		t.Fatalf("in the main library: %d", n)
	}
	if n := len(list("/v1/assets?q=algebra")); n != 1 {
		t.Fatalf("title search found %d", n)
	}
	h.call(c, "GET", "/v1/assets?sort=sideways", key, "", 400)
	// Without a library, a video goes to the main one; a library or folder of another workspace is refused.
	plain := h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+upload()+`"}`, 201)
	if str(plain, "library_id") != mainID || plain["folder_id"] != nil {
		t.Fatalf("default placement: %v", plain)
	}
	if newest, oldest := list("/v1/assets?sort=newest"), list("/v1/assets?sort=oldest"); len(newest) < 2 || str(newest[0].(map[string]any), "id") != str(oldest[len(oldest)-1].(map[string]any), "id") {
		t.Fatalf("oldest should be newest reversed: %v / %v", newest, oldest)
	}
	h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+upload()+`","library_id":"`+mainID+`","folder_id":"`+bid+`"}`, 404) // folder is in another library
	h.call(c, "GET", "/v1/libraries/"+cid+"/folders", other, "", 404)
	h.call(h.client(), "POST", "/v1/assets", other, `{"upload_id":"`+str(h.call(h.client(), "POST", "/v1/uploads", other, "", 201), "id")+`","library_id":"`+cid+`"}`, 404)

	// Rename and move.
	moved := h.call(c, "PATCH", "/v1/assets/"+vid, key, `{"title":"Algebra 1","folder_id":"root"}`, 200)
	if moved["title"] != "Algebra 1" || moved["folder_id"] != nil {
		t.Fatalf("after move: %v", moved)
	}
	moved = h.call(c, "PATCH", "/v1/assets/"+vid, key, `{"library_id":"`+mainID+`"}`, 200)
	if str(moved, "library_id") != mainID {
		t.Fatalf("after moving library: %v", moved)
	}
	if out := h.call(c, "PATCH", "/v1/assets/"+vid, key, `{"folder_id":"`+aid+`"}`, 400); code(out) != "invalid_move" {
		t.Fatalf("folder of another library: %v", out)
	}
	h.call(c, "POST", "/v1/assets/move", "", `{"ids":["`+vid+`"],"library_id":"`+cid+`","folder_id":"`+aid+`"}`, 204)
	if n := len(list("/v1/assets?folder_id=" + aid)); n != 1 {
		t.Fatalf("bulk move: %d", n)
	}

	// The trash: out of lists, not playable, restorable; deleting a folder trashes its videos.
	m3u8 := func(want int) {
		t.Helper()
		res, err := h.ts.Client().Get(h.ts.URL + page + "/playlist.m3u8")
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != want {
			t.Fatalf("playlist: %d, want %d", res.StatusCode, want)
		}
	}
	h.call(c, "POST", "/v1/assets/trash", "", `{"ids":["`+vid+`"]}`, 204)
	if ids(list("/v1/assets"))[vid] || !ids(list("/v1/assets?trashed=true"))[vid] {
		t.Fatal("a trashed video should leave the list and show in the trash")
	}
	if got := h.call(c, "GET", "/v1/assets/"+vid, key, "", 200); got["deleted_at"] == nil {
		t.Fatalf("trashed video: %v", got)
	}
	m3u8(http.StatusNotFound)
	h.call(c, "POST", "/v1/assets/restore", "", `{"ids":["`+vid+`"]}`, 204)
	if !ids(list("/v1/assets"))[vid] {
		t.Fatal("a restored video should be back")
	}
	h.call(c, "DELETE", "/v1/folders/"+aid, "", "", 204)
	if !ids(list("/v1/assets?trashed=true"))[vid] {
		t.Fatal("deleting a folder should trash its videos")
	}
	h.call(c, "POST", "/v1/assets/restore", "", `{"ids":["`+vid+`"]}`, 204)
	if got := h.call(c, "GET", "/v1/assets/"+vid, key, "", 200); got["folder_id"] != nil || got["deleted_at"] != nil {
		t.Fatalf("restored after its folder went: %v", got)
	}

	// A library with videos can't be deleted, nor the main one; an empty one can.
	if out := h.call(c, "DELETE", "/v1/libraries/"+cid, "", "", 409); code(out) != "library_not_empty" {
		t.Fatalf("non-empty: %v", out)
	}
	if out := h.call(c, "DELETE", "/v1/libraries/"+mainID, "", "", 409); code(out) != "library_not_empty" && code(out) != "library_is_default" {
		t.Fatalf("main: %v", out)
	}
	h.call(c, "POST", "/v1/assets/trash", "", `{"ids":["`+vid+`"]}`, 204)
	h.call(c, "POST", "/v1/assets/purge", "", `{"ids":["`+vid+`"]}`, 204)
	h.call(c, "GET", "/v1/assets/"+vid, key, "", 404)
	h.call(c, "POST", "/v1/assets/purge", "", `{"ids":["`+str(plain, "id")+`"]}`, 404) // only trashed videos are purged
	empty := h.call(c, "POST", "/v1/libraries", "", `{"name":"Scratch"}`, 201)
	h.call(c, "DELETE", "/v1/libraries/"+str(empty, "id"), "", "", 204)

	// Settings: validated, saved, and used by new videos.
	h.call(c, "PATCH", "/v1/libraries/"+cid, "", `{"default_playback_policy":"open"}`, 400)
	if out := h.call(c, "PATCH", "/v1/libraries/"+cid, "", `{"allowed_domains":["https://bad.example/x"]}`, 400); code(out) != "invalid_domains" {
		t.Fatalf("bad domain: %v", out)
	}
	set := h.call(c, "PATCH", "/v1/libraries/"+cid, "", `{"mp4_downloads":true,"default_playback_policy":"signed","allowed_domains":["Example.com","*.Shop.org"]}`, 200)
	if set["preset_template"] != "balanced" || set["preset_id"] != nil || set["mp4_downloads"] != true || set["default_playback_policy"] != "signed" || len(set["allowed_domains"].([]any)) != 2 || set["allowed_domains"].([]any)[0] != "example.com" {
		t.Fatalf("settings: %v", set)
	}
	withDownload := h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+upload()+`","library_id":"`+cid+`","playback_policy":"public"}`, 201)
	if withDownload["download"] != "preparing" {
		t.Fatalf("a library with MP4 downloads on should prepare one: %v", withDownload["download"])
	}
	page = h.playPath(withDownload)

	// The player: settings validated and saved per library; the embed's config honours the allowed distributions.
	if out := h.call(c, "PUT", "/v1/libraries/"+cid+"/player", "", `{"accent":"orange","theme":"dark","skip":10}`, 400); code(out) != "invalid_player" {
		t.Fatalf("bad colour: %v", out)
	}
	h.call(c, "PUT", "/v1/libraries/"+cid+"/player", "", `{"accent":"#2563eb","theme":"light","logo_url":"http://insecure.example/l.png","skip":10}`, 400)
	h.call(c, "PUT", "/v1/libraries/"+cid+"/player", "", `{"accent":"#2563eb","theme":"light","autoplay":true,"muted":true,"speed":true,"quality":false,"skip":30,"logo_url":"https://example.com/logo.png"}`, 200)
	if got := h.call(c, "GET", "/v1/libraries/"+cid+"/player", "", "", 200); got["accent"] != "#2563eb" || got["skip"] != 30.0 || got["quality"] != false {
		t.Fatalf("saved player: %v", got)
	}
	if got := h.call(c, "GET", "/v1/libraries/"+mainID+"/player", "", "", 200); got["accent"] != "#10b981" || got["quality"] != true {
		t.Fatalf("another library keeps the defaults: %v", got)
	}
	cfg := func(query string, want int) map[string]any {
		t.Helper()
		return h.call(h.client(), "GET", page+"/config.json"+query, "", "", want)
	}
	if got := cfg("?ref=https://example.com/page", 200); got["settings"].(map[string]any)["accent"] != "#2563eb" || got["policy"] != "public" || got["stream"] != "playlist.m3u8" || got["status"] != "waiting" {
		t.Fatalf("player config: %v", got)
	}
	cfg("?ref=https://www.shop.org/watch", 200)
	for _, ref := range []string{"", "?ref=https://evil.example/", "?ref=https://notexample.com/"} {
		if out := cfg(ref, 403); code(out) != "domain_not_allowed" {
			t.Fatalf("ref %q: %v", ref, out)
		}
	}
	h.call(c, "PATCH", "/v1/libraries/"+cid, "", `{"allowed_domains":[]}`, 200)
	cfg("", 200)
	h.call(h.client(), "GET", "/play/"+cid+"/00000000-0000-4000-8000-000000000000/config.json", "", "", 404)
}
