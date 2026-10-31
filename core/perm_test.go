package core

import (
	"net/http"
	"net/netip"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
)

func TestCan(t *testing.T) {
	user := pgtype.UUID{Valid: true}
	for _, c := range []struct {
		p    Principal
		perm string
		want bool
	}{
		{Principal{UserID: user, Role: "viewer"}, "video:read", true},
		{Principal{UserID: user, Role: "viewer"}, "video:write", false},
		{Principal{UserID: user, Role: "member"}, "video:write", true},
		{Principal{UserID: user, Role: "member"}, "webhooks:write", false},
		{Principal{UserID: user, Role: "admin"}, "webhooks:write", true},
		{Principal{UserID: user, Role: ""}, "video:read", false},
		{Principal{Scopes: []string{"video:read"}}, "video:read", true},
		{Principal{Scopes: []string{"video:read"}}, "video:write", false},
		{Principal{Scopes: []string{"video:write"}}, "video:read", true},
		{Principal{Scopes: []string{"video:write"}}, "webhooks:read", false},
	} {
		if got := c.p.Can(c.perm); got != c.want {
			t.Errorf("%+v Can(%s) = %v", c.p, c.perm, got)
		}
	}
}

func TestValidScopes(t *testing.T) {
	for scopes, want := range map[string]bool{"": false, "video:read": true, "video:read,webhooks:write": true, "video:read,cdn:write": false,
		"video:read,video:write": false, "video:admin": false, "billing:read": false} {
		var s []string
		if scopes != "" {
			s = strings.Split(scopes, ",")
		}
		if ValidScopes(s) != want {
			t.Errorf("ValidScopes(%q) != %v", scopes, want)
		}
	}
}

// An application built on Ulka VMS adds a product: roles grant it like video, and API keys may be scoped to it.
func TestAddProduct(t *testing.T) {
	user := pgtype.UUID{Valid: true}
	viewer, member := Principal{UserID: user, Role: "viewer"}, Principal{UserID: user, Role: "member"}
	if viewer.Can("extra:read") || ValidScopes([]string{"extra:read"}) {
		t.Fatal("a product nobody added is granted")
	}
	AddProduct("extra")
	AddProduct("extra") // twice is once
	if !viewer.Can("extra:read") || viewer.Can("extra:write") || !member.Can("extra:write") || !ValidScopes([]string{"extra:write"}) {
		t.Fatalf("after AddProduct: viewer %v, member %v", viewer.Permissions(), member.Permissions())
	}
	if n := strings.Count(strings.Join(Products, ","), "extra"); n != 1 {
		t.Fatalf("Products lists it %d times", n)
	}
}

func TestClientIP(t *testing.T) {
	proxy := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	for _, c := range []struct{ peer, xff, want string }{
		{"203.0.113.9:1234", "", "203.0.113.9"},
		{"203.0.113.9:1234", "198.51.100.1", "203.0.113.9"},                  // untrusted peer: header ignored
		{"10.0.0.2:1234", "198.51.100.1", "198.51.100.1"},                    // behind our proxy
		{"10.0.0.2:1234", "1.1.1.1, 198.51.100.1, 10.0.0.5", "198.51.100.1"}, // spoofed first entry skipped
		{"10.0.0.2:1234", "", "10.0.0.2"},
	} {
		r := &http.Request{RemoteAddr: c.peer, Header: http.Header{}}
		if c.xff != "" {
			r.Header.Set("X-Forwarded-For", c.xff)
		}
		if got := ClientIP(r, proxy); got.String() != c.want {
			t.Errorf("peer %s xff %q: got %s, want %s", c.peer, c.xff, got, c.want)
		}
	}
	if !ipAllowed(netip.MustParseAddr("1.2.3.4"), nil) || ipAllowed(netip.MustParseAddr("1.2.3.4"), proxy) {
		t.Error("ipAllowed")
	}
}
