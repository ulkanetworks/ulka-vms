package core

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	jsonv2 "encoding/json/v2"
	"errors"
	"log/slog"
	"mime"
	"net/http"
	"net/netip"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"golang.org/x/crypto/bcrypt"

	"github.com/ulkanetworks/ulka-vms/core/db"
)

const SessionCookie = "ulka_session"

// DummyHash is compared against when an email is unknown, so login takes the same time either way.
var DummyHash = func() []byte {
	h, err := bcrypt.GenerateFromPassword([]byte("ulka-dummy-password"), bcrypt.DefaultCost)
	if err != nil {
		panic(err) // without it, sign-ins for unknown emails answer faster and give away which emails exist
	}
	return h
}()

// Deps is what every module's handlers and workers share. River is an insert-only client in the API.
type Deps struct {
	Pool           *pgxpool.Pool
	River          *river.Client[pgx.Tx]
	SealKey        []byte // SEAL_KEY: seals secrets at rest (core.Seal); 32 bytes
	Store          Storage
	PublicURL      string         // where this API and the customer console are reached
	AdminURL       string         // where Ulka admin is reached (its own host)
	OriginURL      string         // where segments are
	PlayerURL      string         // where viewers watch and stream (the player host)
	DocsURL        string         // where the guides and the API reference are read (the docs host)
	PlayerDemo     string         // the video the player host's home shows, as library/video; empty for none
	SignupOpen     bool           // SIGNUP=open: anyone may create a workspace; closed, only invites bring people in
	TrustedProxies []netip.Prefix // proxies whose X-Forwarded-For is believed
	Geo            *Geo           // visitors' countries, for libraries' country rules; nil finds none
	Keys           KeyStore       // a key service; nil keeps keys sealed in the database
	// OnActing records a change made by an Ulka admin using the console as a person (the ops module sets it).
	OnActing func(ctx context.Context, p Principal, method, path string, status int)
}

// Principal is who is calling: a member of a tenant with a role, or an API key (no UserID) with scopes.
type Principal struct {
	TenantID, UserID pgtype.UUID
	Role             string
	Scopes           []string
	Acting           *Acting // set when an Ulka admin is using the console as this person
}

// Acting is the Ulka admin behind a session, and when it ends.
type Acting struct {
	AdminID   pgtype.UUID `json:"-"`
	AdminName string      `json:"admin_name"`
	Until     time.Time   `json:"until"`
	AdminURL  string      `json:"admin_url,omitempty"` // where to go back to, set when the person's profile is read
}

// statusRecorder keeps the status a handler answered with, for recording acting admins' changes.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) { s.status = code; s.ResponseWriter.WriteHeader(code) }

type HandlerFunc func(http.ResponseWriter, *http.Request, Principal)

var (
	ErrForbidden         = APIError{Status: http.StatusForbidden, Code: "forbidden"}
	errInsufficientScope = APIError{Status: http.StatusForbidden, Code: "insufficient_scope"}
	errIPNotAllowed      = APIError{Status: http.StatusForbidden, Code: "ip_not_allowed"}
)

// Auth admits callers allowed perm: Session (signed-in members only), Anyone, or a product permission like "video:write".

func (d *Deps) Auth(perm string, next HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, err := d.Authenticate(r)
		if err != nil {
			RespondError(w, r, err)
			return
		}
		setTenant(r.Context(), p)
		if !p.TenantID.Valid || (perm == Session && !p.UserID.Valid) {
			WriteError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		if perm != Session && perm != Anyone && !p.Can(perm) {
			if p.UserID.Valid {
				RespondError(w, r, ErrForbidden)
			} else {
				RespondError(w, r, errInsufficientScope)
			}
			return
		}
		if p.Acting != nil && r.Method != http.MethodGet && r.Method != http.MethodHead && d.OnActing != nil {
			rec := &statusRecorder{w, http.StatusOK}
			next(rec, r, p)
			d.OnActing(context.WithoutCancel(r.Context()), p, r.Method, r.URL.Path, rec.status)
			return
		}
		next(w, r, p)
	}
}

// Authenticate returns an empty principal, not an error, when credentials are absent or wrong.
func (d *Deps) Authenticate(r *http.Request) (Principal, error) {
	q := db.New(d.Pool)
	if h := r.Header.Get("Authorization"); h != "" {
		key, ok := strings.CutPrefix(h, "Bearer ")
		if !ok {
			return Principal{}, nil
		}
		k, err := q.APIKeyLookup(r.Context(), Hash(key))
		if errors.Is(err, pgx.ErrNoRows) {
			return Principal{}, nil
		}
		if err != nil {
			return Principal{}, err
		}
		if !ipAllowed(ClientIP(r, d.TrustedProxies), k.AllowedIps) {
			return Principal{}, errIPNotAllowed
		}
		return Principal{TenantID: k.TenantID, Scopes: k.Scopes}, q.APIKeyUsed(r.Context(), k.ID)
	}
	c, err := r.Cookie(SessionCookie)
	if err != nil {
		return Principal{}, nil
	}
	row, err := q.SessionLookup(r.Context(), Hash(c.Value))
	if errors.Is(err, pgx.ErrNoRows) {
		return Principal{}, nil
	}
	if err == nil {
		err = q.SessionSeen(r.Context(), Hash(c.Value)) // writes at most every 5 minutes
	}
	p := Principal{TenantID: row.TenantID, UserID: row.UserID, Role: row.Role}
	if row.ActingAdminID.Valid {
		p.Acting = &Acting{AdminID: row.ActingAdminID, AdminName: row.ActingAdminName, Until: row.ExpiresAt.Time}
	}
	return p, err
}

func Hash(s string) []byte {
	h := sha256.Sum256([]byte(s))
	return h[:]
}

// Decode requires a JSON content type, which also keeps cross-site form posts out.
func Decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); mt != "application/json" {
		WriteError(w, http.StatusUnsupportedMediaType, "unsupported_media_type")
		return false
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request")
		return false
	}
	return true
}

// WriteJSON answers with v. Unless the handler said otherwise, nothing may store it: API answers are per caller, and
// a CDN in front of the API (image delivery) must never keep one.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	if w.Header().Get("Cache-Control") == "" {
		w.Header().Set("Cache-Control", "no-store")
	}
	// v1 encoding, except an empty list or map is [] or {}: pages read them as lists, and null crashed them.
	b, err := jsonv2.Marshal(v, json.DefaultOptionsV1(), jsonv2.FormatNilSliceAsNull(false), jsonv2.FormatNilMapAsNull(false))
	if err != nil {
		slog.Error("answer could not be encoded", "err", err) // a bug in the handler, not the caller's doing
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":{"code":"internal","message":"` + Messages["internal"] + `"}}`))
		return
	}
	w.WriteHeader(status)
	w.Write(append(b, '\n')) // a failed write means the caller left; there is no one to tell
}

// WriteError answers with a stable code for programs and its words for people (see Messages).
func WriteError(w http.ResponseWriter, status int, code string) {
	WriteJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": Message(code)}})
}

func InternalError(w http.ResponseWriter, r *http.Request, err error) {
	slog.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
	WriteError(w, http.StatusInternalServerError, "internal")
}

// APIError is an error with a stable code; RespondError writes it, a missing row as not_found, anything else as internal.
type APIError struct {
	Status int
	Code   string
}

func (e APIError) Error() string { return e.Code }

func RespondError(w http.ResponseWriter, r *http.Request, err error) {
	if ae := (APIError{}); errors.As(err, &ae) {
		WriteError(w, ae.Status, ae.Code)
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		WriteError(w, http.StatusNotFound, "not_found")
		return
	}
	InternalError(w, r, err)
}

// WithPathID runs fn in the caller's tenant with the {id} path value; a malformed id is not_found.
func (d *Deps) WithPathID(r *http.Request, p Principal, fn func(TenantTx, pgtype.UUID) error) error {
	var id pgtype.UUID
	if id.Scan(r.PathValue("id")) != nil {
		return APIError{Status: http.StatusNotFound, Code: "not_found"}
	}
	return InScope(r.Context(), d.Pool, p, func(q TenantTx) error { return fn(q, id) })
}
