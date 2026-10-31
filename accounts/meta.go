package accounts

import (
	"net/http"

	"github.com/ulkanetworks/ulka-vms/core"
)

// The API's rules for the console to show and check against, so none of them are restated in the frontend:
// roles and what each may do (worked out from core.RoleCan), API key products, and field limits.
type metaRole struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Summary string `json:"summary"`
}

type metaCapability struct {
	What  string   `json:"what"`
	Roles []string `json:"roles"`
}

type MetaProduct struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Read  string `json:"read"`
	Write string `json:"write"`
}

var metaRoles = []metaRole{
	{"viewer", "Viewer", "Looks, changes nothing"},
	{"member", "Member", "Uses every product; no webhooks, keys or people"},
	{"admin", "Admin", "Everything except managing owners"},
	{"owner", "Owner", "Everything, including other owners"},
}

// Capabilities is the roles table: each row decided by one permission, so it can't drift from what the API allows.
// An application built on ulka-vms may reword or add rows at start.
var Capabilities = []Capability{
	{"See videos and usage", "video:read"},
	{"Upload, change and delete videos", "video:write"},
	{"Add and remove webhooks", "webhooks:write"},
	{"Invite and manage people, create API keys, rename the workspace", "members:write"},
	{"Make or remove owners", "owners:write"},
}

// Capability is one row of the roles table: what, and the permission that decides who may.
type Capability struct{ What, Perm string }

// MetaProducts describes each of core.Products for API key scopes; one added with core.AddProduct is added here too.
var MetaProducts = []MetaProduct{
	{"video", "Video", "List videos, sign playback tokens", "Upload, change and delete videos"},
	{"webhooks", "Webhooks", "See endpoints", "Add and remove endpoints"},
}

// ExtraMeta is more of /v1/meta, by key, that an application built on ulka-vms publishes beside the rest.
var ExtraMeta = map[string]any{}

func (s *module) meta(w http.ResponseWriter, r *http.Request) {
	caps := make([]metaCapability, len(Capabilities))
	for i, c := range Capabilities {
		caps[i] = metaCapability{What: c.What, Roles: []string{}}
		for _, role := range core.Roles {
			if core.RoleCan(role, c.Perm) {
				caps[i].Roles = append(caps[i].Roles, role)
			}
		}
	}
	out := map[string]any{
		"roles":          metaRoles,
		"capabilities":   caps,
		"products":       MetaProducts,
		"messages":       core.Messages,      // every code's words, so clients show the API's wording, never their own
		"webhook_events": core.WebhookEvents, // what an endpoint can receive or choose
		"player_url":     s.PlayerURL,        // where videos are watched and streamed
		"docs_url":       s.DocsURL,          // where the guides and the API reference are read
		"console_url":    s.PublicURL,        // so a page can tell the player host from the console
		"player_demo":    s.PlayerDemo,       // library/video the player host's home shows; "" for none
		"signup_open":    s.SignupOpen,       // whether anyone may create a workspace; closed, only invites bring people in
		"limits":         core.FieldRules,
	}
	for k, v := range ExtraMeta {
		out[k] = v
	}
	core.WriteJSON(w, http.StatusOK, out)
}

// grantable is the roles a member may give others: none above their own, and none without members:write.
func grantable(role string) []string {
	if !core.RoleCan(role, "members:write") {
		return []string{}
	}
	return core.Roles[:core.RoleRank(role)+1]
}

// meFor is what the caller may do: by role for a member, by scope for an API key.
func meFor(p core.Principal, role string) core.Principal {
	return core.Principal{TenantID: p.TenantID, UserID: p.UserID, Role: role, Scopes: p.Scopes}
}
