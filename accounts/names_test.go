package accounts

import (
	"strings"
	"testing"
)

// Names are limited in characters, not bytes: 100 Bangla letters (300 bytes) fit, 101 don't.
func TestNamesCountCharacters(t *testing.T) {
	if _, err := cleanName(strings.Repeat("অ", 100), true); err != nil {
		t.Fatalf("100 characters refused: %v", err)
	}
	if _, err := cleanName(strings.Repeat("অ", 101), true); err == nil {
		t.Fatal("101 characters accepted")
	}
}
