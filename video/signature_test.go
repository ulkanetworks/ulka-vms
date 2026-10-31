package video

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

// A signature round-trips, names what it covers, and fails once anything in it changes.
func TestSignatureFormat(t *testing.T) {
	secret := []byte("0123456789abcdef0123456789abcdef")
	lib, vid := "/2f6c0000-0000-4000-8000-000000000001", "/9a1b0000-0000-4000-8000-000000000002"
	sig := signPath("k1", secret, 1791786728, lib+vid+"/*", "203.0.113.7", "Ada ~ <ada@example.com>")

	signed, mac, ok := strings.Cut(sig, "~hmac=")
	if !ok || strings.Count(sig, "~hmac=") != 1 {
		t.Fatalf("no single hmac: %s", sig)
	}
	h := hmac.New(sha256.New, secret)
	h.Write([]byte(signed))
	if mac != hex.EncodeToString(h.Sum(nil)) {
		t.Fatal("hmac is not over the signed part as written")
	}
	got, err := parseSignature(signed)
	if err != nil {
		t.Fatal(err)
	}
	if got.exp != 1791786728 || got.acl != lib+vid+"/*" || got.kid != "k1" || got.ip != "203.0.113.7" || got.watermark != "Ada ~ <ada@example.com>" {
		t.Fatalf("parsed %+v", got)
	}
	if strings.Contains(signed, "/") {
		t.Fatalf("a signature must stay one path segment: %s", signed)
	}

	for path, want := range map[string]bool{
		lib + vid:                     true, // the page itself
		lib + vid + "/playlist.m3u8":  true,
		lib + vid + "/captions/x.vtt": true,
		lib + vid + "x/playlist.m3u8": false, // a longer id that only starts the same
		lib + "/other/playlist.m3u8":  false,
	} {
		if got.covers(path) != want {
			t.Errorf("covers(%s) = %v, want %v", path, !want, want)
		}
	}
	libWide := signature{acl: lib + "/*"}
	if !libWide.covers(lib+vid+"/key") || libWide.covers("/elsewhere"+vid+"/key") {
		t.Error("a library-wide acl covers its own videos only")
	}

	for name, bad := range map[string]string{
		"unknown field": "exp=1~acl=%2Fa%2F%2A~kid=k~zz=1",
		"repeated":      "exp=1~acl=%2Fa%2F%2A~exp=2~kid=k",
		"no acl":        "exp=1~kid=k",
		"relative acl":  "exp=1~acl=a%2F%2A~kid=k",
		"no exp":        "acl=%2Fa%2F%2A~kid=k",
	} {
		if _, err := parseSignature(bad); err == nil {
			t.Errorf("%s: accepted %q", name, bad)
		}
	}
}
