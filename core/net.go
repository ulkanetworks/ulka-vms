package core

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"syscall"
	"time"
)

var cgnat = netip.MustParsePrefix("100.64.0.0/10")

// PublicIP reports whether a is reachable on the public internet, so we never fetch from our own network for a customer.
func PublicIP(a netip.Addr) bool {
	a = a.Unmap()
	return a.IsGlobalUnicast() && !a.IsPrivate() && !a.IsLoopback() && !a.IsLinkLocalUnicast() && !cgnat.Contains(a)
}

// PublicClient only connects to public addresses, checked on the resolved IP at connect time so DNS cannot
// sneak past it, and never follows redirects.
func PublicClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy: nil,
			DialContext: (&net.Dialer{Timeout: 10 * time.Second, Control: func(_, address string, _ syscall.RawConn) error {
				ap, err := netip.ParseAddrPort(address)
				if err != nil || !PublicIP(ap.Addr()) {
					return errors.New("not a public address")
				}
				return nil
			}}).DialContext,
			TLSHandshakeTimeout: 10 * time.Second,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// LookupIP resolves origin hostnames when they are saved; tests replace it.
var LookupIP = net.DefaultResolver.LookupNetIP

var hostnameRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$`)

// ValidHostname reports whether s is a lowercase DNS name with at least two labels.
func ValidHostname(s string) bool { return len(s) <= 253 && hostnameRe.MatchString(s) }

// CDNURL is a customer's own CDN address as delivery uses it, "https://<host>" with nothing after; false otherwise.
func CDNURL(raw string) (string, bool) {
	u, err := url.Parse(strings.TrimSuffix(strings.TrimSpace(raw), "/"))
	if err != nil || u.Scheme != "https" || !ValidHostname(strings.ToLower(u.Hostname())) || u.Port() != "" ||
		(u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.User != nil {
		return "", false
	}
	return "https://" + strings.ToLower(u.Hostname()), true
}

var (
	ErrInvalidOrigin = APIError{Status: http.StatusBadRequest, Code: "invalid_origin"}
	ErrOriginPrivate = APIError{Status: http.StatusBadRequest, Code: "origin_not_public"}
)

// CheckOrigin accepts an http(s) URL with no path, query or credentials, whose host is, or resolves only to,
// public addresses: we fetch from it for customers, and must never be pointed at our own network.
// ponytail: checked when saved; DNS can change later, so fetchers also refuse private addresses at connect time.
func CheckOrigin(ctx context.Context, raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil ||
		(u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || len(raw) > MaxURL {
		return ErrInvalidOrigin
	}
	return CheckPublicHost(ctx, u.Hostname())
}

// CheckPublicHost accepts a public IP address, or a hostname that resolves only to public addresses.
func CheckPublicHost(ctx context.Context, host string) error {
	if a, err := netip.ParseAddr(host); err == nil {
		if !PublicIP(a) {
			return ErrOriginPrivate
		}
		return nil
	}
	if !ValidHostname(strings.ToLower(host)) {
		return ErrInvalidOrigin
	}
	addrs, err := LookupIP(ctx, "ip", host)
	if err != nil || len(addrs) == 0 {
		return ErrInvalidOrigin
	}
	for _, a := range addrs {
		if !PublicIP(a) {
			return ErrOriginPrivate
		}
	}
	return nil
}
