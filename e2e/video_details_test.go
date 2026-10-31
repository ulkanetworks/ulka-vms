package e2e

import (
	"testing"
)

// A video's description, tags, metadata and chapters: set through the API, found by tag and metadata, and chapters
// handed to the player.
func TestVideoDetails(t *testing.T) {
	h := newHarness(t)
	_, key := h.signup("viddetails")
	c := h.client()
	up := h.call(c, "POST", "/v1/uploads", key, "", 201)
	id := h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+up["id"].(string)+`"}`, 201)["id"].(string)

	h.call(c, "PATCH", "/v1/assets/"+id, key, `{"tags":["a,b"]}`, 400)
	h.call(c, "PATCH", "/v1/assets/"+id, key, `{"metadata":[{"key":"order id","value":"1"}]}`, 400)
	v := h.call(c, "PATCH", "/v1/assets/"+id, key, `{"description":" Launch talk ","tags":["Launch","launch","2026"],"metadata":[{"key":"order","value":"42"}]}`, 200)
	if v["description"] != "Launch talk" || len(v["tags"].([]any)) != 2 || v["metadata"].([]any)[0].(map[string]any)["value"] != "42" {
		t.Fatalf("details: %v %v %v", v["description"], v["tags"], v["metadata"])
	}
	// A title change leaves the details alone.
	if v := h.call(c, "PATCH", "/v1/assets/"+id, key, `{"title":"Talk"}`, 200); v["description"] != "Launch talk" || len(v["tags"].([]any)) != 2 {
		t.Fatalf("details lost: %v", v)
	}

	found := func(q string) int { return len(h.call(c, "GET", "/v1/assets?"+q, key, "", 200)["data"].([]any)) }
	if found("tag=Launch") != 1 || found("tag=other") != 0 || found("metadata_key=order&metadata_value=42") != 1 ||
		found("metadata_key=order&metadata_value=7") != 0 || found("q=launch") != 1 || found("") != 1 {
		t.Fatal("filters")
	}

	// Chapters come back in order; overlaps are refused. (The upload was never sent, so the length is unknown.)
	h.call(c, "PUT", "/v1/assets/"+id+"/chapters", key, `{"chapters":[{"title":"A","start_time":0,"end_time":20},{"title":"B","start_time":10,"end_time":30}]}`, 400)
	v = h.call(c, "PUT", "/v1/assets/"+id+"/chapters", key, `{"chapters":[{"title":"Second","start_time":30,"end_time":60},{"title":"First","start_time":0,"end_time":30}]}`, 200)
	if ch := v["chapters"].([]any); len(ch) != 2 || ch[0].(map[string]any)["title"] != "First" {
		t.Fatalf("chapters: %v", v["chapters"])
	}
	page := h.playPath(h.call(c, "PATCH", "/v1/assets/"+id, key, `{"playback_policy":"public"}`, 200))
	if ch := h.call(c, "GET", page+"/config.json", "", "", 200)["chapters"].([]any); len(ch) != 2 {
		t.Fatalf("player chapters: %v", ch)
	}
	h.call(c, "PUT", "/v1/assets/"+id+"/chapters", key, `{"chapters":[]}`, 200)
}
