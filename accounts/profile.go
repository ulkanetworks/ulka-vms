package accounts

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/nyaruka/phonenumbers"
	"golang.org/x/crypto/bcrypt"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/core/db"
)

var emailTokens = map[string]struct {
	ttl     time.Duration
	path    string
	subject string
	body    string
}{
	"verify_email":   {7 * 24 * time.Hour, "/verify-email", "Confirm your email address", "Confirm your email address for Ulka:"},
	"change_email":   {24 * time.Hour, "/verify-email", "Confirm your new email address", "Confirm this is your new email address for Ulka:"},
	"reset_password": {time.Hour, "/reset-password", "Reset your password", "Someone asked to reset your Ulka password. If it was you, choose a new one here within an hour:"},
}

// sendEmailToken replaces the user's earlier tokens of this purpose, so only the newest link works. q needs a user scope.
func (s *module) sendEmailToken(ctx context.Context, q core.TenantTx, purpose, email string) error {
	t := emailTokens[purpose]
	token := rand.Text()
	if err := q.DeleteEmailTokens(ctx, purpose); err != nil {
		return err
	}
	if err := q.CreateEmailToken(ctx, db.CreateEmailTokenParams{
		TokenHash: core.Hash(token), Purpose: purpose, Email: email,
		ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(t.ttl), Valid: true},
	}); err != nil {
		return err
	}
	link := s.PublicURL + t.path + "?" + url.Values{"token": {token}, "kind": {purpose}}.Encode()
	return core.SendMail(ctx, email, t.subject, t.body+"\n\n"+link+"\n")
}

// useEmailToken resolves a link's token to its user; the caller consumes it by deleting that purpose's tokens.
func (s *module) useEmailToken(ctx context.Context, token, purpose string) (db.EmailTokenLookupRow, error) {
	row, err := db.New(s.Pool).EmailTokenLookup(ctx, db.EmailTokenLookupParams{TokenHash: core.Hash(token), Purpose: purpose})
	if errors.Is(err, pgx.ErrNoRows) {
		return row, errInvalidToken
	}
	return row, err
}

func (s *module) updateMe(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var in struct {
		Name   string  `json:"name"`
		Phone  *string `json:"phone"`  // any country, international form (E.164) like +14155550100; "" removes it; left out keeps it
		Locale *string `json:"locale"` // en or bn; left out keeps it
		// An IANA name like Asia/Dhaka, or UTC or GMT; "" goes back to the browser's own; left out keeps it
		Timezone *string `json:"timezone"`
	}
	if !core.Decode(w, r, &in) {
		return
	}
	name, err := cleanName(in.Name, false)
	if err == nil {
		err = core.InScope(r.Context(), s.Pool, p, func(q core.TenantTx) error {
			if err := q.UpdateUserName(r.Context(), name); err != nil || (in.Phone == nil && in.Locale == nil && in.Timezone == nil) {
				return err
			}
			u, err := q.GetUserAccount(r.Context())
			if err != nil {
				return err
			}
			phone, locale, zone := u.Phone, u.Locale, u.Timezone
			if in.Phone != nil {
				if phone, err = cleanPhone(*in.Phone); err != nil {
					return err
				}
			}
			if in.Locale != nil {
				if locale = *in.Locale; locale != "en" && locale != "bn" {
					return errInvalidLocale
				}
			}
			if in.Timezone != nil {
				if zone, err = cleanTimezone(*in.Timezone); err != nil {
					return err
				}
			}
			return q.UpdateUserContact(r.Context(), db.UpdateUserContactParams{Phone: phone, Locale: locale, Timezone: zone})
		})
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	s.writeMe(w, r, p, http.StatusOK)
}

// checkPassword compares against the signed-in user's hash; q needs a user scope.
func checkPassword(ctx context.Context, q core.TenantTx, pw string) error {
	h, err := q.GetUserPasswordHash(ctx)
	if err != nil {
		return err
	}
	if bcrypt.CompareHashAndPassword([]byte(h), []byte(pw)) != nil {
		return errWrongPassword
	}
	return nil
}

// changePassword also signs out every other session, since a changed password usually means a worry.
func (s *module) changePassword(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var in struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if !core.Decode(w, r, &in) {
		return
	}
	pwHash, err := hashPassword(in.NewPassword)
	if err == nil {
		err = core.InScope(r.Context(), s.Pool, p, func(q core.TenantTx) error {
			if err := checkPassword(r.Context(), q, in.CurrentPassword); err != nil {
				return err
			}
			if err := q.UpdateUserPassword(r.Context(), pwHash); err != nil {
				return err
			}
			_, err := q.DeleteOtherSessions(r.Context(), sessionToken(r))
			return err
		})
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// changeEmail sends a link to the new address; the address changes only once that link is opened.
func (s *module) changeEmail(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var in struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !core.Decode(w, r, &in) {
		return
	}
	email, err := cleanEmail(in.Email)
	if err == nil {
		err = core.InScope(r.Context(), s.Pool, p, func(q core.TenantTx) error {
			if err := checkPassword(r.Context(), q, in.Password); err != nil {
				return err
			}
			// The lookup returns one row, NULL when the address is free.
			if id, err := q.UserIDByEmail(r.Context(), email); err != nil {
				return err
			} else if id.Valid {
				return errEmailTaken
			}
			return s.sendEmailToken(r.Context(), q, "change_email", email)
		})
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (s *module) revokeOtherSessions(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var n int64
	err := core.InScope(r.Context(), s.Pool, p, func(q core.TenantTx) (err error) {
		n, err = q.DeleteOtherSessions(r.Context(), sessionToken(r))
		return err
	})
	if err != nil {
		core.InternalError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, map[string]int64{"revoked": n})
}

func (s *module) resendVerification(w http.ResponseWriter, r *http.Request, p core.Principal) {
	err := core.InScope(r.Context(), s.Pool, p, func(q core.TenantTx) error {
		u, err := q.GetUserAccount(r.Context())
		if err != nil || u.EmailVerifiedAt.Valid {
			return err
		}
		if recent, err := q.RecentEmailToken(r.Context(), "verify_email"); err != nil || recent {
			return err
		}
		return s.sendEmailToken(r.Context(), q, "verify_email", u.Email)
	})
	if err != nil {
		core.InternalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

// verifyEmail confirms an address from a link: the sign-up address (verify_email) or a new one (change_email).
func (s *module) verifyEmail(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token string `json:"token"`
		Kind  string `json:"kind"`
	}
	if !core.Decode(w, r, &in) {
		return
	}
	if in.Kind != "verify_email" && in.Kind != "change_email" {
		core.RespondError(w, r, errInvalidToken)
		return
	}
	row, err := s.useEmailToken(r.Context(), in.Token, in.Kind)
	if err == nil {
		err = core.InScope(r.Context(), s.Pool, core.Principal{UserID: row.UserID}, func(q core.TenantTx) error {
			if err := q.DeleteEmailTokens(r.Context(), in.Kind); err != nil {
				return err
			}
			if in.Kind == "verify_email" {
				_, err := q.MarkEmailVerified(r.Context(), row.Email)
				return err
			}
			if err := q.SetUserEmail(r.Context(), row.Email); isUniqueViolation(err) {
				return errEmailTaken
			} else {
				return err
			}
		})
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// requestPasswordReset always answers 202, so it never reveals whether an address has an account.
func (s *module) requestPasswordReset(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email string `json:"email"`
	}
	if !core.Decode(w, r, &in) {
		return
	}
	email := strings.TrimSpace(in.Email)
	userID, err := db.New(s.Pool).UserIDByEmail(r.Context(), email)
	if err == nil && userID.Valid {
		err = core.InScope(r.Context(), s.Pool, core.Principal{UserID: userID}, func(q core.TenantTx) error {
			u, err := q.GetUserAccount(r.Context())
			if err != nil {
				return err
			}
			// One email a minute per account, so the form cannot be used to flood someone's inbox.
			if recent, err := q.RecentEmailToken(r.Context(), "reset_password"); err != nil || recent {
				return err
			}
			return s.sendEmailToken(r.Context(), q, "reset_password", u.Email)
		})
	}
	if err != nil {
		core.InternalError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

// confirmPasswordReset sets the new password and signs the user out everywhere; they sign in again with it.
func (s *module) confirmPasswordReset(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if !core.Decode(w, r, &in) {
		return
	}
	pwHash, err := hashPassword(in.Password)
	var row db.EmailTokenLookupRow
	if err == nil {
		row, err = s.useEmailToken(r.Context(), in.Token, "reset_password")
	}
	if err == nil {
		err = core.InScope(r.Context(), s.Pool, core.Principal{UserID: row.UserID}, func(q core.TenantTx) error {
			if err := q.DeleteEmailTokens(r.Context(), "reset_password"); err != nil {
				return err
			}
			if err := q.UpdateUserPassword(r.Context(), pwHash); err != nil {
				return err
			}
			// The link reached the inbox, which proves the address as well as a verify link would.
			if _, err := q.MarkEmailVerified(r.Context(), row.Email); err != nil {
				return err
			}
			return q.DeleteAllSessions(r.Context())
		})
	}
	if err == nil {
		// Whoever reset the password owns the address; earlier failed guesses shouldn't lock them out.
		err = core.NewSignInGuard(s.Pool, "user", row.Email).Record(r.Context(), true)
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

var (
	errInvalidPhone    = core.APIError{Status: http.StatusBadRequest, Code: "invalid_phone"}
	errInvalidLocale   = core.APIError{Status: http.StatusBadRequest, Code: "invalid_locale"}
	errInvalidTimezone = core.APIError{Status: http.StatusBadRequest, Code: "invalid_timezone"}
)

// cleanPhone accepts an international number written the usual ways (spaces, dashes, brackets) that libphonenumber's
// full rules call valid for its country, and keeps it as E.164. The console checks with libphonenumber-js/max, the same rules.
func cleanPhone(v string) (pgtype.Text, error) {
	if v = strings.TrimSpace(v); v == "" {
		return pgtype.Text{}, nil
	}
	n, err := phonenumbers.Parse(v, "") // no default country: the number starts with + and its country code
	if err != nil || !strings.HasPrefix(v, "+") || !phonenumbers.IsValidNumber(n) {
		return pgtype.Text{}, errInvalidPhone
	}
	return pgtype.Text{String: phonenumbers.Format(n, phonenumbers.E164), Valid: true}, nil
}

// listSessions is where the caller is signed in: when each session started and was last used, from which address
// and browser, and which one is this. Tokens never leave the server.
func (s *module) listSessions(w http.ResponseWriter, r *http.Request, p core.Principal) {
	c, err := r.Cookie(core.SessionCookie)
	if err != nil {
		core.WriteError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	type session struct {
		CreatedAt  pgtype.Timestamptz `json:"created_at"`
		LastSeenAt pgtype.Timestamptz `json:"last_seen_at"`
		IP         string             `json:"ip"`
		UserAgent  string             `json:"user_agent"`
		Current    bool               `json:"current"`
		UlkaAdmin  string             `json:"ulka_admin,omitempty"` // Ulka support using the console as this person
	}
	out := []session{}
	err = core.InScope(r.Context(), s.Pool, p, func(q core.TenantTx) error {
		rows, err := q.ListMySessions(r.Context())
		for _, row := range rows {
			out = append(out, session{row.CreatedAt, row.LastSeenAt, row.Ip, row.UserAgent, bytes.Equal(row.TokenHash, core.Hash(c.Value)), row.ActingAdminName})
		}
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, map[string]any{"data": out})
}

// cleanTimezone accepts an IANA zone name the server knows, or "" to clear it.
func cleanTimezone(v string) (pgtype.Text, error) {
	if v == "" {
		return pgtype.Text{}, nil
	}
	if _, err := time.LoadLocation(v); err != nil || v == "Local" || len(v) > 64 {
		return pgtype.Text{}, errInvalidTimezone
	}
	return pgtype.Text{String: v, Valid: true}, nil
}
