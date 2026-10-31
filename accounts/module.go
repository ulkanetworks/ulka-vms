package accounts

import (
	"net/http"

	"github.com/ulkanetworks/ulka-vms/core"
)

type module struct{ *core.Deps }

func Routes(mux *http.ServeMux, d *core.Deps) {
	s := &module{d}
	mux.HandleFunc("POST /v1/signup", s.signup)
	mux.HandleFunc("POST /v1/login", s.login)
	mux.HandleFunc("POST /v1/logout", s.Auth(core.Session, s.logout))
	mux.HandleFunc("GET /v1/me", s.Auth(core.Anyone, s.me))
	mux.HandleFunc("GET /v1/meta", s.meta)                  // public: rules only, nothing about any workspace
	mux.HandleFunc("POST /v1/client-errors", s.clientError) // a page that broke reports itself, signed in or not
	mux.HandleFunc("POST /v1/api-keys", s.Auth(core.Session, s.createAPIKey))
	mux.HandleFunc("GET /v1/api-keys", s.Auth(core.Session, s.listAPIKeys))
	mux.HandleFunc("GET /v1/api-keys/{id}", s.Auth(core.Session, s.showAPIKey))
	mux.HandleFunc("DELETE /v1/api-keys/{id}", s.Auth(core.Session, s.deleteAPIKey))

	mux.HandleFunc("PATCH /v1/me", s.Auth(core.Session, ownOnly(s.updateMe)))
	mux.HandleFunc("POST /v1/me/password", s.Auth(core.Session, ownOnly(s.changePassword)))
	mux.HandleFunc("POST /v1/me/email", s.Auth(core.Session, ownOnly(s.changeEmail)))
	mux.HandleFunc("GET /v1/me/sessions", s.Auth(core.Session, ownOnly(s.listSessions)))
	mux.HandleFunc("POST /v1/me/sessions/revoke-others", s.Auth(core.Session, ownOnly(s.revokeOtherSessions)))
	mux.HandleFunc("POST /v1/me/verify-email/resend", s.Auth(core.Session, ownOnly(s.resendVerification)))
	mux.HandleFunc("POST /v1/verify-email", s.verifyEmail)
	mux.HandleFunc("POST /v1/password-reset", s.requestPasswordReset)
	mux.HandleFunc("POST /v1/password-reset/confirm", s.confirmPasswordReset)

	mux.HandleFunc("GET /v1/tenants", s.Auth(core.Session, s.listTenants))
	mux.HandleFunc("POST /v1/tenants", s.Auth(core.Session, ownOnly(s.createTenant)))
	mux.HandleFunc("POST /v1/tenants/{id}/switch", s.Auth(core.Session, ownOnly(s.switchTenant)))
	mux.HandleFunc("PATCH /v1/tenant", s.Auth(core.Session, s.renameTenant))
	mux.HandleFunc("GET /v1/members", s.Auth(core.Session, s.listMembers))
	mux.HandleFunc("PATCH /v1/members/{id}", s.Auth(core.Session, s.setMemberRole))
	mux.HandleFunc("DELETE /v1/members/{id}", s.Auth(core.Session, s.removeMember))
	mux.HandleFunc("POST /v1/invites", s.Auth(core.Session, s.createInvite))
	mux.HandleFunc("GET /v1/invites", s.Auth(core.Session, s.listInvites))
	mux.HandleFunc("DELETE /v1/invites/{id}", s.Auth(core.Session, s.deleteInvite))
	mux.HandleFunc("GET /v1/invites/lookup", s.lookupInvite)
	mux.HandleFunc("POST /v1/invites/accept", s.acceptInvite)
}

var errActingNotAllowed = core.APIError{Status: http.StatusForbidden, Code: "acting_not_allowed"}

// ownOnly keeps a person's own account (sign-in details, sessions, confirmation emails, which workspace they're in)
// theirs alone: an Ulka admin using the console as them may do anything else, but not these. Signing out stays open.
func ownOnly(next core.HandlerFunc) core.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request, p core.Principal) {
		if p.Acting != nil {
			core.RespondError(w, r, errActingNotAllowed)
			return
		}
		next(w, r, p)
	}
}
