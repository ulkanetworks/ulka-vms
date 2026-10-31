package core

import (
	"net/http"
	"net/netip"
	"slices"
	"strings"
)

// Auth permissions that aren't a product's.
const (
	Session = "session" // signed-in members only: account, workspace and billing
	Anyone  = "any"     // any member or API key of the tenant
)

// Products are what API key scopes grant, each at "read" or "write" (which includes read). AddProduct adds more.
var Products = []string{"video", "webhooks"}

// Roles, least to most; each can do all the one before it can. Nobody may give a role above their own.
var Roles = []string{"viewer", "member", "admin", "owner"}

// roleGrants is the single statement of what each role may do. Besides products it covers "members"
// (people and invites), "keys" (API keys), "workspace" (its name and settings) and "owners" (making or removing owners); owners may do everything.
var roleGrants = map[string]map[string]string{
	"viewer": {"video": "read", "webhooks": "read", "members": "read", "workspace": "read"},
	"member": {"video": "write", "webhooks": "read", "members": "read", "workspace": "read"},
	"admin":  {"video": "write", "webhooks": "write", "members": "write", "keys": "write", "workspace": "write"},
}

// AddProduct adds a product an application built on ulka-vms serves, granted like video: viewers read, members and
// admins write. Call it at start, before serving.
func AddProduct(name string) {
	if slices.Contains(Products, name) {
		return
	}
	Products = append(Products, name)
	roleGrants["viewer"][name], roleGrants["member"][name], roleGrants["admin"][name] = "read", "write", "write"
}

// RoleCan reports whether a role grants perm, as in "video:read" or "members:write".
func RoleCan(role, perm string) bool {
	product, level, _ := strings.Cut(perm, ":")
	if role == "owner" {
		return true
	}
	g := roleGrants[role][product]
	return g == "write" || (g == "read" && level == "read")
}

// RoleRank orders roles; -1 for an unknown one.
func RoleRank(role string) int { return slices.Index(Roles, role) }

// Can reports whether p may use a product at a level: by role for a member, by scope for an API key.
func (p Principal) Can(perm string) bool {
	if p.UserID.Valid {
		return RoleCan(p.Role, perm)
	}
	product, level, _ := strings.Cut(perm, ":")
	return slices.Contains(p.Scopes, product+":write") || (level == "read" && slices.Contains(p.Scopes, perm))
}

// Permissions lists everything p may do, each at its highest level, for the console to show only what works.
func (p Principal) Permissions() []string {
	out := []string{}
	for _, product := range append(slices.Clone(Products), "members", "keys", "workspace", "owners") {
		switch {
		case p.Can(product + ":write"):
			out = append(out, product+":write")
		case p.Can(product + ":read"):
			out = append(out, product+":read")
		}
	}
	return out
}

// ValidScopes reports whether scopes name known products at most once each, at "read" or "write".
func ValidScopes(scopes []string) bool {
	seen := map[string]bool{}
	for _, s := range scopes {
		product, level, _ := strings.Cut(s, ":")
		if seen[product] || !slices.Contains(Products, product) || (level != "read" && level != "write") {
			return false
		}
		seen[product] = true
	}
	return len(scopes) > 0
}

// ClientIP is the caller's address: the peer, or when the peer is a trusted proxy, the last address in
// X-Forwarded-For that isn't one (earlier entries are whatever the client claimed).
func ClientIP(r *http.Request, trusted []netip.Prefix) netip.Addr {
	ap, err := netip.ParseAddrPort(r.RemoteAddr)
	if err != nil {
		return netip.Addr{}
	}
	ip, xff := ap.Addr().Unmap(), r.Header.Get("X-Forwarded-For")
	if xff == "" {
		return ip
	}
	hops := strings.Split(xff, ",")
	for i := len(hops) - 1; i >= 0 && inAny(ip, trusted); i-- {
		next, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if err != nil {
			return netip.Addr{}
		}
		ip = next.Unmap()
	}
	return ip
}

// ParsePrefix reads an address ("203.0.113.9") or a range ("203.0.113.0/24").
func ParsePrefix(s string) (netip.Prefix, error) {
	s = strings.TrimSpace(s)
	if a, err := netip.ParseAddr(s); err == nil {
		return netip.PrefixFrom(a, a.BitLen()), nil
	}
	p, err := netip.ParsePrefix(s)
	return p.Masked(), err
}

// ipAllowed is true for any address when the list is empty.
func ipAllowed(ip netip.Addr, allowed []netip.Prefix) bool {
	return len(allowed) == 0 || inAny(ip, allowed)
}

func inAny(ip netip.Addr, prefixes []netip.Prefix) bool {
	return slices.ContainsFunc(prefixes, func(p netip.Prefix) bool { return p.Contains(ip) })
}
