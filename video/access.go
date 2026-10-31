package video

import (
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/ulkanetworks/ulka-vms/core"
)

// Access is who may watch a library's videos (docs.ulka.co's referrer and country policies): by the website the
// player is on, and by the viewer's country. Signed tokens are the security; these keep casual copying out.
type Access struct {
	AllowedDomains []string `json:"allowed_domains"` // only these websites; empty for any
	BlockedDomains []string `json:"blocked_domains"` // every website but these
	CountryMode    string   `json:"country_mode"`    // allow: everywhere but Countries; deny: only Countries
	Countries      []string `json:"countries"`       // two-letter codes
}

// accessInput is the part of a library or defaults update that changes Access; nil leaves a field as it is.
type accessInput struct {
	AllowedDomains *[]string `json:"allowed_domains"`
	BlockedDomains *[]string `json:"blocked_domains"`
	CountryMode    *string   `json:"country_mode"`
	Countries      *[]string `json:"countries"`
}

var (
	errInvalidCountries  = core.APIError{Status: http.StatusBadRequest, Code: "invalid_countries"}
	errOneWebsiteList    = core.APIError{Status: http.StatusBadRequest, Code: "invalid_website_lists"}
	errDomainNotAllowed  = core.APIError{Status: http.StatusForbidden, Code: "domain_not_allowed"}
	errCountryNotAllowed = core.APIError{Status: http.StatusForbidden, Code: "country_not_allowed"}
	countryCode          = regexp.MustCompile(`^[A-Z]{2}$`)
)

func (a Access) orEmpty() Access {
	for _, l := range []*[]string{&a.AllowedDomains, &a.BlockedDomains, &a.Countries} {
		if *l == nil {
			*l = []string{}
		}
	}
	return a
}

// clean checks the input; setting one website list empties the other, since a library uses one or the other.
func (in accessInput) clean() (allowed, blocked []string, mode pgtype.Text, countries []string, err error) {
	if in.AllowedDomains != nil && in.BlockedDomains != nil && len(*in.AllowedDomains) > 0 && len(*in.BlockedDomains) > 0 {
		return nil, nil, mode, nil, errOneWebsiteList
	}
	if in.AllowedDomains != nil {
		if allowed, err = cleanDomains(*in.AllowedDomains); err != nil {
			return
		}
		if len(allowed) > 0 && in.BlockedDomains == nil {
			blocked = []string{}
		}
	}
	if in.BlockedDomains != nil {
		if blocked, err = cleanDomains(*in.BlockedDomains); err != nil {
			return
		}
		if len(blocked) > 0 && in.AllowedDomains == nil {
			allowed = []string{}
		}
	}
	if in.CountryMode != nil {
		if *in.CountryMode != "allow" && *in.CountryMode != "deny" {
			return nil, nil, mode, nil, errInvalidCountries
		}
		mode = pgtype.Text{String: *in.CountryMode, Valid: true}
	}
	if in.Countries != nil {
		countries = []string{}
		for _, c := range *in.Countries {
			c = strings.ToUpper(strings.TrimSpace(c))
			if !countryCode.MatchString(c) {
				return nil, nil, mode, nil, errInvalidCountries
			}
			if !slices.Contains(countries, c) {
				countries = append(countries, c)
			}
		}
		if len(countries) > 250 {
			return nil, nil, mode, nil, errInvalidCountries
		}
	}
	return
}

func (in accessInput) touched() bool {
	return in.AllowedDomains != nil || in.BlockedDomains != nil || in.CountryMode != nil || in.Countries != nil
}

// WebsiteAllowed checks the page the player is on (its address, from document.referrer) against the website lists.
func (a Access) WebsiteAllowed(pageURL string) error {
	if len(a.AllowedDomains) > 0 && !websiteListed(pageURL, a.AllowedDomains) || len(a.BlockedDomains) > 0 && websiteListed(pageURL, a.BlockedDomains) {
		return errDomainNotAllowed
	}
	return nil
}

// CountryAllowed checks the viewer's country. One the database can't place is allowed when the library allows by default
// and refused when it allows only some countries, except on this network. With no database the rule is off.
func (a Access) CountryAllowed(geo *core.Geo, ip netip.Addr) error {
	if a.CountryMode == "allow" && len(a.Countries) == 0 || geo == nil { // no database: the rule is off, viewers are served
		return nil
	}
	c := geo.Country(ip)
	listed := slices.Contains(a.Countries, c)
	switch {
	case c == "" && (ip.IsLoopback() || ip.IsPrivate()):
		return nil
	case a.CountryMode == "deny" && !listed, a.CountryMode == "allow" && listed:
		return errCountryNotAllowed
	}
	return nil
}

// websiteListed says whether a page's address is on the list; an entry like *.example.com matches the domain and its subdomains.
func websiteListed(pageURL string, list []string) bool {
	u, err := url.Parse(pageURL)
	if err != nil || u.Hostname() == "" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	for _, a := range list {
		a = strings.ToLower(a)
		if suffix, wild := strings.CutPrefix(a, "*."); wild && (host == suffix || strings.HasSuffix(host, "."+suffix)) || host == a {
			return true
		}
	}
	return false
}
