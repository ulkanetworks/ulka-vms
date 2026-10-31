package accounts

import (
	"context"
	"crypto/rand"
	"errors"
	"log/slog"
	"net/http"
	"net/mail"
	"net/netip"
	"strings"
	"time"
	"unicode/utf8"
	"uuid"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"golang.org/x/crypto/bcrypt"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/core/db"
)

const sessionTTL = 30 * 24 * time.Hour

var (
	errForbidden     = core.APIError{Status: http.StatusForbidden, Code: "forbidden"}
	errInvalidEmail  = core.APIError{Status: http.StatusBadRequest, Code: "invalid_email"}
	errInvalidPass   = core.APIError{Status: http.StatusBadRequest, Code: "invalid_password"}
	errInvalidName   = core.APIError{Status: http.StatusBadRequest, Code: "invalid_name"}
	errInvalidRole   = core.APIError{Status: http.StatusBadRequest, Code: "invalid_role"}
	errEmailTaken    = core.APIError{Status: http.StatusConflict, Code: "email_taken"}
	errSignupClosed  = core.APIError{Status: http.StatusForbidden, Code: "signup_closed"}
	errInvalidToken  = core.APIError{Status: http.StatusBadRequest, Code: "invalid_token"}
	errWrongPassword = core.APIError{Status: http.StatusBadRequest, Code: "wrong_password"}
)

func cleanEmail(s string) (string, error) {
	s = strings.TrimSpace(s)
	if addr, err := mail.ParseAddress(s); err != nil || addr.Address != s || len(s) > core.MaxEmail {
		return "", errInvalidEmail
	}
	return s, nil
}

func hashPassword(pw string) (string, error) {
	if len(pw) < core.MinPassword || len(pw) > core.MaxPassword {
		return "", errInvalidPass
	}
	h, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.DefaultCost)
	return string(h), err
}

func cleanName(s string, required bool) (string, error) {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > core.MaxName || (required && s == "") {
		return "", errInvalidName
	}
	return s, nil
}

func isUniqueViolation(err error) bool {
	pgErr := (*pgconn.PgError)(nil)
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// requirePerm returns the caller's role in the current tenant, read in this transaction, or errForbidden
// when the role doesn't grant perm.
func requirePerm(ctx context.Context, q core.TenantTx, perm string) (string, error) {
	role, err := q.MemberRole(ctx, q.UserID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !core.RoleCan(role, perm)) {
		return role, errForbidden
	}
	return role, err
}

func (s *module) signup(w http.ResponseWriter, r *http.Request) {
	if !s.SignupOpen {
		core.RespondError(w, r, errSignupClosed)
		return
	}
	var in struct {
		Email      string `json:"email"`
		Password   string `json:"password"`
		TenantName string `json:"tenant_name"`
		Name       string `json:"name"`
	}
	if !core.Decode(w, r, &in) {
		return
	}
	email, err := cleanEmail(in.Email)
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	pwHash, err := hashPassword(in.Password)
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	tenantName, err1 := cleanName(in.TenantName, true)
	name, err2 := cleanName(in.Name, false)
	if err := errors.Join(err1, err2); err != nil {
		core.RespondError(w, r, errInvalidName)
		return
	}
	row, err := db.New(s.Pool).Signup(r.Context(), db.SignupParams{Email: email, PasswordHash: pwHash, TenantName: tenantName, Name: name})
	if isUniqueViolation(err) {
		core.RespondError(w, r, errEmailTaken)
		return
	}
	if err != nil {
		core.InternalError(w, r, err)
		return
	}
	p := core.Principal{TenantID: row.TenantID, UserID: row.UserID}
	if err := core.InScope(r.Context(), s.Pool, p, func(q core.TenantTx) error {
		return s.sendEmailToken(r.Context(), q, "verify_email", email)
	}); err != nil {
		// The account exists either way; the console's confirm-your-email reminder can send it again.
		slog.ErrorContext(r.Context(), "verification email not sent", "err", err)
	}
	s.startSession(w, r, p, http.StatusCreated)
}

func (s *module) login(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !core.Decode(w, r, &in) {
		return
	}
	email := strings.TrimSpace(in.Email)
	guard := core.NewSignInGuard(s.Pool, "user", email)
	blocked, err := guard.Blocked(r.Context())
	if err != nil {
		core.InternalError(w, r, err)
		return
	}
	if blocked {
		core.RespondError(w, r, core.ErrTooManyAttempts)
		return
	}
	row, err := db.New(s.Pool).LoginLookup(r.Context(), email)
	if errors.Is(err, pgx.ErrNoRows) {
		_ = bcrypt.CompareHashAndPassword(core.DummyHash, []byte(in.Password)) // only to take as long as a real check
		s.loginFailed(w, r, guard)
		return
	}
	if err != nil {
		core.InternalError(w, r, err)
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(row.PasswordHash), []byte(in.Password)) != nil {
		s.loginFailed(w, r, guard)
		return
	}
	if err := guard.Record(r.Context(), true); err != nil {
		core.InternalError(w, r, err)
		return
	}
	// Someone removed from every tenant still signs in, into a fresh workspace of their own.
	if !row.TenantID.Valid {
		if row.TenantID, err = s.newTenant(r.Context(), row.UserID, "My workspace"); err != nil {
			core.InternalError(w, r, err)
			return
		}
	}
	s.startSession(w, r, core.Principal{TenantID: row.TenantID, UserID: row.UserID}, http.StatusOK)
}

func (s *module) loginFailed(w http.ResponseWriter, r *http.Request, guard core.SignInGuard) {
	if err := guard.Record(r.Context(), false); err != nil {
		core.InternalError(w, r, err)
		return
	}
	core.WriteError(w, http.StatusUnauthorized, "invalid_credentials")
}

// newTenant creates a tenant with userID as its owner.
func (s *module) newTenant(ctx context.Context, userID pgtype.UUID, name string) (pgtype.UUID, error) {
	id := pgtype.UUID{Bytes: uuid.New(), Valid: true}
	return id, core.InScope(ctx, s.Pool, core.Principal{TenantID: id, UserID: userID}, func(q core.TenantTx) error {
		if err := q.CreateTenant(ctx, name); err != nil {
			return err
		}
		return q.AddMember(ctx, db.AddMemberParams{UserID: userID, Role: "owner"})
	})
}

func (s *module) startSession(w http.ResponseWriter, r *http.Request, p core.Principal, status int) {
	token, expires := rand.Text(), time.Now().Add(sessionTTL)
	var ip *netip.Addr
	if a := core.ClientIP(r, s.TrustedProxies); a.IsValid() {
		ip = &a
	}
	err := core.InScope(r.Context(), s.Pool, p, func(q core.TenantTx) error {
		if err := q.CreateSession(r.Context(), db.CreateSessionParams{
			TokenHash: core.Hash(token), UserID: p.UserID, ExpiresAt: pgtype.Timestamptz{Time: expires, Valid: true},
			CreatedIp: ip, UserAgent: r.UserAgent(),
		}); err != nil {
			return err
		}
		return q.UserSignedIn(r.Context(), p.UserID)
	})
	if err != nil {
		core.InternalError(w, r, err)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: core.SessionCookie, Value: token, Path: "/", Expires: expires, HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode})
	s.writeMe(w, r, p, status)
}

func sessionToken(r *http.Request) []byte {
	c, _ := r.Cookie(core.SessionCookie) // session-only routes are reached only with the cookie
	return core.Hash(c.Value)
}

func (s *module) logout(w http.ResponseWriter, r *http.Request, p core.Principal) {
	if err := core.InScope(r.Context(), s.Pool, p, func(q core.TenantTx) error {
		return q.DeleteSession(r.Context(), sessionToken(r))
	}); err != nil {
		core.InternalError(w, r, err)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: core.SessionCookie, Path: "/", MaxAge: -1, HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode})
	w.WriteHeader(http.StatusNoContent)
}

func (s *module) me(w http.ResponseWriter, r *http.Request, p core.Principal) {
	s.writeMe(w, r, p, http.StatusOK)
}

func (s *module) writeMe(w http.ResponseWriter, r *http.Request, p core.Principal, status int) {
	var out struct {
		Tenant         db.GetTenantRow       `json:"tenant"`
		User           *db.GetUserAccountRow `json:"user,omitempty"`
		Role           string                `json:"role,omitempty"`
		Permissions    []string              `json:"permissions"`      // what the caller may do, e.g. "cdn:write"
		GrantableRoles []string              `json:"grantable_roles"`  // roles the caller may give others
		Acting         *core.Acting          `json:"acting,omitempty"` // an Ulka admin is using the console as this person
		MaxUploadBytes int64                 `json:"max_upload_bytes"` // the largest file this workspace may upload
	}
	if p.Acting != nil {
		a := *p.Acting
		a.AdminURL = s.AdminURL
		out.Acting = &a
	}
	err := core.InScope(r.Context(), s.Pool, p, func(q core.TenantTx) (err error) {
		if out.Tenant, err = q.GetTenant(r.Context()); err != nil {
			return err
		}
		lim, err := core.LimitsFor(r.Context(), q)
		if out.MaxUploadBytes = lim.MaxUploadBytes; err != nil || !p.UserID.Valid {
			return err
		}
		u, err := q.GetUserAccount(r.Context())
		if err != nil {
			return err
		}
		out.User = &u
		out.Role, err = q.MemberRole(r.Context(), p.UserID)
		return err
	})
	if err != nil {
		core.InternalError(w, r, err)
		return
	}
	out.Permissions, out.GrantableRoles = meFor(p, out.Role).Permissions(), grantable(out.Role)
	core.WriteJSON(w, status, out)
}

var (
	errInvalidScopes  = core.APIError{Status: http.StatusBadRequest, Code: "invalid_scopes"}
	errInvalidIPRange = core.APIError{Status: http.StatusBadRequest, Code: "invalid_ip_range"}
	errInvalidExpiry  = core.APIError{Status: http.StatusBadRequest, Code: "invalid_expiry"}
)

func (s *module) createAPIKey(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var in struct {
		Name       string     `json:"name"`
		Scopes     []string   `json:"scopes"`      // "video:read", "cdn:write", ...
		AllowedIPs []string   `json:"allowed_ips"` // addresses or ranges; empty for any
		ExpiresAt  *time.Time `json:"expires_at"`
	}
	if !core.Decode(w, r, &in) {
		return
	}
	name, err := cleanName(in.Name, true)
	if err == nil && !core.ValidScopes(in.Scopes) {
		err = errInvalidScopes
	}
	if err == nil && in.ExpiresAt != nil && !in.ExpiresAt.After(time.Now()) {
		err = errInvalidExpiry
	}
	ips, ipErr := parseIPRanges(in.AllowedIPs)
	if err == nil {
		err = ipErr
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	var expires pgtype.Timestamptz
	if in.ExpiresAt != nil {
		expires = pgtype.Timestamptz{Time: *in.ExpiresAt, Valid: true}
	}
	key := "sk_" + rand.Text()
	var out struct {
		db.CreateAPIKeyRow
		Key string `json:"key"`
	}
	out.Key = key
	err = core.InScope(r.Context(), s.Pool, p, func(q core.TenantTx) (err error) {
		if _, err := requirePerm(r.Context(), q, "keys:write"); err != nil {
			return err
		}
		out.CreateAPIKeyRow, err = q.CreateAPIKey(r.Context(), db.CreateAPIKeyParams{Name: name, Prefix: key[:10], KeyHash: core.Hash(key),
			Scopes: in.Scopes, AllowedIps: ips, ExpiresAt: expires})
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusCreated, out)
}

// parseIPRanges accepts up to 50 addresses or ranges; a range covering everything (/0) is refused as a likely mistake.
func parseIPRanges(in []string) ([]netip.Prefix, error) {
	out := []netip.Prefix{}
	for _, v := range in {
		p, err := core.ParsePrefix(v)
		if err != nil || p.Bits() == 0 || len(in) > core.MaxKeyIPs {
			return nil, errInvalidIPRange
		}
		out = append(out, p)
	}
	return out, nil
}

// listAPIKeys pages the keys by cursor, newest first; ?q= searches the name and prefix.
func (s *module) listAPIKeys(w http.ResponseWriter, r *http.Request, p core.Principal) {
	c, err := core.ParseCursor(r)
	var after pgtype.UUID
	if err == nil {
		after, err = c.AfterUUID()
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	keys := []db.ListAPIKeysRow{}
	var total int64
	err = core.InScope(r.Context(), s.Pool, p, func(q core.TenantTx) error {
		if _, err := requirePerm(r.Context(), q, "keys:read"); err != nil {
			return err // names, prefixes and scopes are for those who manage keys
		}
		rows, err := q.ListAPIKeys(r.Context(), db.ListAPIKeysParams{Pattern: c.Like(), AfterAt: c.At, AfterID: after, Lim: c.Fetch()})
		keys = append(keys, rows...)
		if err != nil {
			return err
		}
		total, err = q.CountAPIKeys(r.Context(), c.Like())
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, core.PagedTotal(keys, c, func(k db.ListAPIKeysRow) (time.Time, string) { return k.CreatedAt.Time, k.ID.String() }, total))
}

func (s *module) showAPIKey(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var key db.GetAPIKeyRow
	err := s.WithPathID(r, p, func(q core.TenantTx, id pgtype.UUID) (err error) {
		if _, err := requirePerm(r.Context(), q, "keys:read"); err != nil {
			return err
		}
		key, err = q.GetAPIKey(r.Context(), id)
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, key)
}

func (s *module) deleteAPIKey(w http.ResponseWriter, r *http.Request, p core.Principal) {
	err := s.WithPathID(r, p, func(q core.TenantTx, id pgtype.UUID) error {
		if _, err := requirePerm(r.Context(), q, "keys:write"); err != nil {
			return err
		}
		n, err := q.DeleteAPIKey(r.Context(), id)
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
