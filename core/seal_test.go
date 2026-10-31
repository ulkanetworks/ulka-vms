package core

import (
	"bytes"
	"testing"
)

func TestSeal(t *testing.T) {
	key := bytes.Repeat([]byte{7}, 32)
	sealed, err := Seal(key, []byte("private key"))
	if err != nil {
		t.Fatal(err)
	}
	if got, err := Open(key, sealed); err != nil || string(got) != "private key" {
		t.Fatalf("open: %q %v", got, err)
	}
	sealed[len(sealed)-1] ^= 1
	if _, err := Open(key, sealed); err == nil {
		t.Fatal("tampered value opened")
	}
	if _, err := Open(bytes.Repeat([]byte{8}, 32), sealed); err == nil {
		t.Fatal("opened with the wrong key")
	}
}
