package e2e

import (
	"net/http"
	"net/netip"
	"testing"
)

// A library's website and country rules (docs.ulka.co's referrer and country policies) stop the player and the stream.
func TestVideoAccessRules(t *testing.T) {
	h := newHarness(t)
	c, key := h.signup("vidaccess")
	up := h.call(c, "POST", "/v1/uploads", key, "", 201)
	v := h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+up["id"].(string)+`","playback_policy":"public"}`, 201)
	page, lib := h.playPath(v), v["library_id"].(string)

	h.call(c, "PATCH", "/v1/libraries/"+lib, key, `{"allowed_domains":["a.example"],"blocked_domains":["b.example"]}`, 400)
	h.call(c, "PATCH", "/v1/libraries/"+lib, key, `{"countries":["USA"]}`, 400)
	h.call(c, "PATCH", "/v1/libraries/"+lib, key, `{"country_mode":"sometimes"}`, 400)

	player := func(ref, from string) int {
		req, _ := http.NewRequest("GET", h.ts.URL+page+"/config.json?ref="+ref, nil)
		if from != "" {
			req.Header.Set("X-Forwarded-For", from)
		}
		res, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	// Every website but the blocked one; setting it empties the allowed list.
	h.call(c, "PATCH", "/v1/libraries/"+lib, key, `{"allowed_domains":["a.example"]}`, 200)
	got := h.call(c, "PATCH", "/v1/libraries/"+lib, key, `{"blocked_domains":["*.bad.example"]}`, 200)
	if len(got["allowed_domains"].([]any)) != 0 || len(got["blocked_domains"].([]any)) != 1 {
		t.Fatalf("website lists: %v %v", got["allowed_domains"], got["blocked_domains"])
	}
	if player("https://shop.bad.example/p", "") != 403 || player("https://good.example/p", "") != 200 || player("", "") != 200 {
		t.Fatal("blocked websites")
	}

	if h.cfg.Geo == nil {
		t.Skip("no GEOIP_DB: country rules need the IP database")
	}
	us, au := netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("1.1.1.1")
	cu, ca := h.cfg.Geo.Country(us), h.cfg.Geo.Country(au)
	if cu == "" || cu == ca {
		t.Fatalf("test addresses: %q %q", cu, ca)
	}
	// Only the listed country; this machine itself (no proxy header) is always let through.
	h.call(c, "PATCH", "/v1/libraries/"+lib, key, `{"country_mode":"deny","countries":["`+cu+`"]}`, 200)
	if player("", us.String()) != 200 || player("", au.String()) != 403 || player("", "") != 200 {
		t.Fatal("deny by default")
	}
	// Everywhere but the listed country, the stream included.
	h.call(c, "PATCH", "/v1/libraries/"+lib, key, `{"country_mode":"allow"}`, 200)
	if player("", us.String()) != 403 || player("", au.String()) != 200 {
		t.Fatal("allow by default")
	}
	req, _ := http.NewRequest("GET", h.ts.URL+page+"/playlist.m3u8", nil)
	req.Header.Set("X-Forwarded-For", us.String())
	if res, err := c.Do(req); err != nil || res.StatusCode != 403 {
		t.Fatalf("stream from a blocked country: %v %v", res.StatusCode, err)
	}
}
