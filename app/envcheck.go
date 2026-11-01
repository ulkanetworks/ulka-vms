package app

import (
	"fmt"
	"net/mail"
	"net/url"
	"strings"
)

// CheckEnv judges the environment of a deployment that is not on this machine (PUBLIC_URL not local) and returns
// every setting that would make it look healthy while it isn't: development stand-ins, example values and
// addresses that only exist on this machine. warns are legitimate but worth seeing.
func CheckEnv(get func(string) string) (errs, warns []string) {
	if IsLocal(get("PUBLIC_URL")) {
		return nil, nil
	}
	bad := func(format string, a ...any) { errs = append(errs, fmt.Sprintf(format, a...)) }

	if u, _ := url.Parse(get("PUBLIC_URL")); u == nil || u.Scheme != "https" {
		bad("PUBLIC_URL must be https on a public deployment")
	}
	for _, name := range []string{"PUBLIC_URL", "ORIGIN_URL", "PLAYER_URL", "DOCS_URL"} {
		u, _ := url.Parse(get(name))
		switch {
		case u == nil || u.Hostname() == "":
		case IsLocal(get(name)):
			bad("%s is %s, an address that only exists on this machine: viewers and other machines cannot reach it", name, get(name))
		case Placeholder(u.Hostname()):
			bad("%s is %s, an example value: set the real address", name, get(name))
		}
	}
	// Running without email is allowed (the installer offers it), but never silently, and never as a fallback that
	// would hide a broken provider.
	if get("MAIL_PROVIDER") == "log" {
		warns = append(warns, "MAIL_PROVIDER=log: emails (invitations, password resets) are only written to this log, not sent; set SMTP_URL to send them")
	}
	if get("MAIL_FALLBACK") == "log" {
		bad("MAIL_FALLBACK=log would hide a failing email provider: emails would quietly go to the log instead")
	}
	if a, err := mail.ParseAddress(get("MAIL_FROM")); err == nil {
		if _, host, _ := strings.Cut(a.Address, "@"); Placeholder(host) {
			bad("MAIL_FROM is %s, an example address: set a real one", a.Address)
		}
	}
	return errs, warns
}

// Placeholder is example.com, .org or .net and anything under them.
func Placeholder(host string) bool {
	for _, tld := range []string{"com", "org", "net"} {
		if host == "example."+tld || strings.HasSuffix(host, ".example."+tld) {
			return true
		}
	}
	return false
}
