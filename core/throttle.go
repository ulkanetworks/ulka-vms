package core

import (
	"context"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ulkanetworks/ulka-vms/core/db"
)

// ErrTooManyAttempts is answered after 10 failed sign-ins for an address within 15 minutes.
var ErrTooManyAttempts = APIError{Status: http.StatusTooManyRequests, Code: "too_many_attempts"}

// SignInGuard refuses an address that has failed too often, and records each outcome. key namespaces the
// address ("user:" or "admin:"); unknown addresses count too, so the limit reveals nothing about accounts.
type SignInGuard struct {
	pool *pgxpool.Pool
	key  string
}

func NewSignInGuard(pool *pgxpool.Pool, kind, email string) SignInGuard {
	return SignInGuard{pool, kind + ":" + email}
}

func (g SignInGuard) Blocked(ctx context.Context) (bool, error) {
	return db.New(g.pool).LoginBlocked(ctx, g.key)
}

func (g SignInGuard) Record(ctx context.Context, ok bool) error {
	if ok {
		return db.New(g.pool).LoginSucceeded(ctx, g.key)
	}
	return db.New(g.pool).LoginFailed(ctx, g.key)
}
