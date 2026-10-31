package accounts

import (
	"crypto/rand"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/core/db"
)

const inviteTTL = 7 * 24 * time.Hour

var (
	errLastOwner     = core.APIError{Status: http.StatusConflict, Code: "last_owner"}
	errAlreadyMember = core.APIError{Status: http.StatusConflict, Code: "already_member"}
	errLoginRequired = core.APIError{Status: http.StatusConflict, Code: "login_required"}
	errInviteEmail   = core.APIError{Status: http.StatusForbidden, Code: "invite_email_mismatch"}
)

func validRole(role string) bool { return core.RoleRank(role) >= 0 }

func (s *module) listTenants(w http.ResponseWriter, r *http.Request, p core.Principal) {
	tenants := []db.MyTenantsRow{}
	err := core.InScope(r.Context(), s.Pool, p, func(q core.TenantTx) error {
		rows, err := q.MyTenants(r.Context())
		tenants = append(tenants, rows...)
		return err
	})
	if err != nil {
		core.InternalError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, map[string]any{"data": tenants})
}

// createTenant makes a new tenant owned by the caller and moves this session into it.
func (s *module) createTenant(w http.ResponseWriter, r *http.Request, p core.Principal) {
	if !s.SignupOpen { // a new workspace is a sign-up by another door
		core.RespondError(w, r, errSignupClosed)
		return
	}
	var in struct {
		Name string `json:"name"`
	}
	if !core.Decode(w, r, &in) {
		return
	}
	name, err := cleanName(in.Name, true)
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	id, err := s.newTenant(r.Context(), p.UserID, name)
	if err != nil {
		core.InternalError(w, r, err)
		return
	}
	s.switchTo(w, r, p, id, http.StatusCreated)
}

func (s *module) switchTenant(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var id pgtype.UUID
	if id.Scan(r.PathValue("id")) != nil {
		core.WriteError(w, http.StatusNotFound, "not_found")
		return
	}
	s.switchTo(w, r, p, id, http.StatusOK)
}

// switchTo points this session at tenant id; the query itself refuses a tenant the user is not an active member of.
func (s *module) switchTo(w http.ResponseWriter, r *http.Request, p core.Principal, id pgtype.UUID, status int) {
	err := core.InScope(r.Context(), s.Pool, p, func(q core.TenantTx) error {
		n, err := q.SwitchSessionTenant(r.Context(), db.SwitchSessionTenantParams{TenantID: id, TokenHash: sessionToken(r)})
		if err == nil && n == 0 {
			return pgx.ErrNoRows
		}
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	s.writeMe(w, r, core.Principal{TenantID: id, UserID: p.UserID}, status)
}

func (s *module) renameTenant(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var in struct {
		Name string `json:"name"`
	}
	if !core.Decode(w, r, &in) {
		return
	}
	err := core.InScope(r.Context(), s.Pool, p, func(q core.TenantTx) error {
		if _, err := requirePerm(r.Context(), q, "workspace:write"); err != nil {
			return err
		}
		return RenameWorkspace(r.Context(), q, in.Name)
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	s.writeMe(w, r, p, http.StatusOK)
}

type memberView struct {
	db.ListMembersRow
	CanChange bool `json:"can_change"` // the caller may change this member's role or remove them (guardOwnerChange)
}

// listMembers pages the members by cursor, newest first; ?q= searches the email and name.
func (s *module) listMembers(w http.ResponseWriter, r *http.Request, p core.Principal) {
	c, err := core.ParseCursor(r)
	var after pgtype.UUID
	if err == nil {
		after, err = c.AfterUUID()
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	members := []memberView{}
	var total int64
	err = core.InScope(r.Context(), s.Pool, p, func(q core.TenantTx) error {
		rows, err := q.ListMembers(r.Context(), db.ListMembersParams{Pattern: c.Like(), AfterAt: c.At, AfterID: after, Lim: c.Fetch()})
		if err != nil {
			return err
		}
		for _, m := range rows {
			can := m.ID != p.UserID && core.RoleCan(p.Role, "members:write") && (m.Role != "owner" || core.RoleCan(p.Role, "owners:write"))
			members = append(members, memberView{m, can})
		}
		total, err = q.CountMembers(r.Context(), c.Like())
		return err
	})
	if err != nil {
		core.InternalError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, core.PagedTotal(members, c, func(m memberView) (time.Time, string) { return m.JoinedAt.Time, m.ID.String() }, total))
}

// guardOwnerChange enforces the rules shared by role changes and removals: admins manage members and admins,
// only owners touch owners, anyone may step down or leave, and a tenant always keeps one owner.
func guardOwnerChange(r *http.Request, q core.TenantTx, p core.Principal, target pgtype.UUID, newRole string) error {
	if target == q.UserID && p.Acting != nil {
		return errActingNotAllowed // support may manage others, never the person's own membership
	}
	callerRole, err := q.MemberRole(r.Context(), q.UserID)
	if err != nil {
		return err
	}
	targetRole, err := q.MemberRole(r.Context(), target)
	if err != nil {
		return err
	}
	self := target == q.UserID
	if !self && !core.RoleCan(callerRole, "members:write") {
		return errForbidden
	}
	if (targetRole == "owner" || core.RoleRank(newRole) > core.RoleRank(callerRole)) && !core.RoleCan(callerRole, "owners:write") {
		return errForbidden // nobody grants above their own role
	}
	if targetRole == "owner" && newRole != "owner" {
		if n, err := q.CountOwners(r.Context()); err != nil {
			return err
		} else if n == 1 {
			return errLastOwner
		}
	}
	return nil
}

func (s *module) setMemberRole(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var in struct {
		Role string `json:"role"`
	}
	if !core.Decode(w, r, &in) {
		return
	}
	if !validRole(in.Role) {
		core.RespondError(w, r, errInvalidRole)
		return
	}
	err := s.WithPathID(r, p, func(q core.TenantTx, target pgtype.UUID) error {
		if err := guardOwnerChange(r, q, p, target, in.Role); err != nil {
			return err
		}
		_, err := q.SetMemberRole(r.Context(), db.SetMemberRoleParams{Role: in.Role, UserID: target})
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// removeMember removes someone, or the caller themselves (leaving). Their sessions in this tenant end with it;
// someone leaving is moved to their next tenant, or a fresh one of their own.
func (s *module) removeMember(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var target pgtype.UUID
	err := s.WithPathID(r, p, func(q core.TenantTx, id pgtype.UUID) error {
		target = id
		if err := guardOwnerChange(r, q, p, id, ""); err != nil {
			return err
		}
		if _, err := q.RemoveMember(r.Context(), id); err != nil {
			return err
		}
		return q.DeleteMemberSessions(r.Context(), id)
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	if target != p.UserID {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	var next pgtype.UUID
	err = core.InScope(r.Context(), s.Pool, core.Principal{UserID: p.UserID}, func(q core.TenantTx) error {
		rows, err := q.MyTenants(r.Context())
		for _, t := range rows {
			if !t.SuspendedAt.Valid {
				next = t.ID
				break
			}
		}
		return err
	})
	if err == nil && !next.Valid {
		next, err = s.newTenant(r.Context(), p.UserID, "My workspace")
	}
	if err != nil {
		core.InternalError(w, r, err)
		return
	}
	s.startSession(w, r, core.Principal{TenantID: next, UserID: p.UserID}, http.StatusOK)
}

func (s *module) createInvite(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var in struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if !core.Decode(w, r, &in) {
		return
	}
	email, err := cleanEmail(in.Email)
	if err == nil && !validRole(in.Role) {
		err = errInvalidRole
	}
	var out db.UpsertInviteRow
	if err == nil {
		err = core.InScope(r.Context(), s.Pool, p, func(q core.TenantTx) error {
			role, err := requirePerm(r.Context(), q, "members:write")
			if err != nil {
				return err
			}
			if core.RoleRank(in.Role) > core.RoleRank(role) {
				return errForbidden // nobody grants above their own role
			}
			member, err := q.IsMemberEmail(r.Context(), email)
			if err != nil {
				return err
			}
			if member {
				return errAlreadyMember
			}
			tenant, err := q.GetTenant(r.Context())
			if err != nil {
				return err
			}
			token := rand.Text()
			if out, err = q.UpsertInvite(r.Context(), db.UpsertInviteParams{
				Email: email, Role: in.Role, TokenHash: core.Hash(token), InvitedBy: p.UserID,
				ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(inviteTTL), Valid: true},
			}); err != nil {
				return err
			}
			link := s.PublicURL + "/invite?" + url.Values{"token": {token}}.Encode()
			return core.SendMail(r.Context(), email, "You're invited to "+tenant.Name+" on Ulka",
				"You've been invited to join "+tenant.Name+" on Ulka as "+in.Role+". Accept within 7 days:\n\n"+link+"\n")
		})
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusCreated, out)
}

// listInvites pages the open invites by cursor, newest first; ?q= searches the email.
func (s *module) listInvites(w http.ResponseWriter, r *http.Request, p core.Principal) {
	c, err := core.ParseCursor(r)
	var after pgtype.UUID
	if err == nil {
		after, err = c.AfterUUID()
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	invites := []db.ListInvitesRow{}
	var total int64
	err = core.InScope(r.Context(), s.Pool, p, func(q core.TenantTx) error {
		if _, err := requirePerm(r.Context(), q, "members:write"); err != nil {
			return err
		}
		rows, err := q.ListInvites(r.Context(), db.ListInvitesParams{Pattern: c.Like(), AfterAt: c.At, AfterID: after, Lim: c.Fetch()})
		invites = append(invites, rows...)
		if err != nil {
			return err
		}
		total, err = q.CountInvites(r.Context(), c.Like())
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, core.PagedTotal(invites, c, func(i db.ListInvitesRow) (time.Time, string) { return i.CreatedAt.Time, i.ID.String() }, total))
}

func (s *module) deleteInvite(w http.ResponseWriter, r *http.Request, p core.Principal) {
	err := s.WithPathID(r, p, func(q core.TenantTx, id pgtype.UUID) error {
		if _, err := requirePerm(r.Context(), q, "members:write"); err != nil {
			return err
		}
		n, err := q.DeleteInvite(r.Context(), id)
		if err == nil && n == 0 {
			return pgx.ErrNoRows
		}
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *module) findInvite(r *http.Request, token string) (db.InviteLookupRow, error) {
	inv, err := db.New(s.Pool).InviteLookup(r.Context(), core.Hash(token))
	if errors.Is(err, pgx.ErrNoRows) {
		return inv, errInvalidToken
	}
	return inv, err
}

// lookupInvite lets the invite page show the tenant and whether to ask for sign-in or a new password.
func (s *module) lookupInvite(w http.ResponseWriter, r *http.Request) {
	inv, err := s.findInvite(r, r.URL.Query().Get("token"))
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, map[string]any{
		"tenant_name": inv.TenantName, "email": inv.Email, "role": inv.Role, "account_exists": inv.AccountExists,
	})
}

// acceptInvite joins as the signed-in user when their email matches, or creates the account when none exists.
func (s *module) acceptInvite(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token    string `json:"token"`
		Name     string `json:"name"`
		Password string `json:"password"`
	}
	if !core.Decode(w, r, &in) {
		return
	}
	inv, err := s.findInvite(r, in.Token)
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	caller, err := s.Authenticate(r)
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	userID, status := caller.UserID, http.StatusOK
	if userID.Valid {
		err = core.InScope(r.Context(), s.Pool, core.Principal{UserID: userID}, func(q core.TenantTx) error {
			u, err := q.GetUserAccount(r.Context())
			if err == nil && !strings.EqualFold(u.Email, inv.Email) {
				return errInviteEmail
			}
			return err
		})
	} else if inv.AccountExists {
		err = errLoginRequired
	} else {
		var pwHash, name string
		if pwHash, err = hashPassword(in.Password); err == nil {
			name, err = cleanName(in.Name, false)
		}
		if err == nil {
			userID, err = db.New(s.Pool).CreateInvitedUser(r.Context(), db.CreateInvitedUserParams{Email: inv.Email, PasswordHash: pwHash, Name: name})
			status = http.StatusCreated
		}
		if isUniqueViolation(err) {
			err = errLoginRequired
		}
	}
	if err == nil {
		err = core.InScope(r.Context(), s.Pool, core.Principal{TenantID: inv.TenantID, UserID: userID}, func(q core.TenantTx) error {
			if err := q.AddMember(r.Context(), db.AddMemberParams{UserID: userID, Role: inv.Role}); err != nil {
				return err
			}
			_, err := q.DeleteInvite(r.Context(), inv.ID)
			return err
		})
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	p := core.Principal{TenantID: inv.TenantID, UserID: userID}
	if caller.UserID.Valid {
		s.switchTo(w, r, core.Principal{TenantID: caller.TenantID, UserID: userID}, inv.TenantID, http.StatusOK)
		return
	}
	s.startSession(w, r, p, status)
}
