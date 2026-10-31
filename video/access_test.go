package video

import (
	"net/netip"
	"testing"
)

// Without the IP country database a country rule is off: viewers are served, not refused.
func TestCountryRuleOffWithoutDatabase(t *testing.T) {
	only := Access{CountryMode: "deny", Countries: []string{"BD"}}
	if err := only.CountryAllowed(nil, netip.MustParseAddr("8.8.8.8")); err != nil {
		t.Fatalf("no database must not refuse: %v", err)
	}
	if err := (Access{BlockedDomains: []string{"*.bad.example"}}).WebsiteAllowed("https://x.bad.example/p"); err == nil {
		t.Fatal("website rules work without the database")
	}
}
