package e2e

import "testing"

// A video's privacy changes in place (its link keeps the same address), and the list filters by it.
func TestVideoPrivacy(t *testing.T) {
	h := newHarness(t)
	c, key := h.signup("privacy")
	add := func(policy string) map[string]any {
		t.Helper()
		up := h.call(c, "POST", "/v1/uploads", key, "", 201)
		body := `{"upload_id":"` + up["id"].(string) + `"`
		if policy != "" {
			body += `,"playback_policy":"` + policy + `"`
		}
		return h.call(c, "POST", "/v1/assets", key, body+`}`, 201)
	}
	count := func(q string) int { return len(h.call(c, "GET", "/v1/assets"+q, key, "", 200)["data"].([]any)) }
	// No policy given: the library's default, public unless it was changed.
	pub, priv, bare := add("public"), add("signed"), add("")
	if bare["playback_policy"] != "public" || count("?policy=public") != 2 || count("?policy=signed") != 1 || count("") != 3 {
		t.Fatal("policy filter counts are wrong")
	}
	if total := h.call(c, "GET", "/v1/assets?policy=signed&limit=1", key, "", 200)["total"]; total != 1.0 {
		t.Fatalf("filtered total %v", total)
	}
	h.call(c, "GET", "/v1/assets?policy=secret", key, "", 400)

	// Public to signed: same address, now needing a signature, so it moves to the other filter.
	got := h.call(c, "PATCH", "/v1/assets/"+pub["id"].(string), key, `{"playback_policy":"signed"}`, 200)
	if got["playback_policy"] != "signed" || got["embed_url"] != pub["embed_url"] || got["playback_url"] != pub["embed_url"].(string)+"/playlist.m3u8" {
		t.Fatalf("after making it signed: %v", got)
	}
	if count("?policy=public") != 1 || count("?policy=signed") != 2 {
		t.Fatal("filters did not follow the change")
	}
	// A bad policy is refused.
	h.call(c, "PATCH", "/v1/assets/"+priv["id"].(string), key, `{"playback_policy":"open"}`, 400)
}
