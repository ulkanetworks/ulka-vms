package core

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ulkanetworks/ulka-vms/core/db"
)

// Connect opens a pool and refuses a role that would skip row-level security.
func Connect(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	// Each running encode holds a connection for its tenant slot; leave room for River and requests.
	cfg.MaxConns = max(cfg.MaxConns, 20)
	cfg.ConnConfig.Tracer = dbTracer{} // queries inside a traced request or job become its spans (observe.go)
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	var bypassesRLS bool
	if err := pool.QueryRow(ctx, "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user").Scan(&bypassesRLS); err != nil {
		pool.Close()
		return nil, err
	}
	if bypassesRLS {
		pool.Close()
		return nil, errors.New("DATABASE_URL role bypasses row-level security; connect as ulka_app")
	}
	return pool, nil
}

// JobTimeout bounds any one job, long enough for packaging a 12-hour video.
const JobTimeout = 4 * time.Hour

// TenantTx is a transaction scoped by RLS to one tenant and, when UserID is set, to that user's own rows.
type TenantTx struct {
	*db.Queries
	pgx.Tx
	TenantID pgtype.UUID
	UserID   pgtype.UUID
}

// InTenant runs fn in a transaction scoped by RLS to one tenant.
func InTenant(ctx context.Context, pool *pgxpool.Pool, tenantID pgtype.UUID, fn func(TenantTx) error) error {
	return InScope(ctx, pool, Principal{TenantID: tenantID}, fn)
}

// InScope sets app.tenant_id and app.user_id from p; either may be unset.
func InScope(ctx context.Context, pool *pgxpool.Pool, p Principal, fn func(TenantTx) error) error {
	return pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
			uuidOrEmpty(p.TenantID), uuidOrEmpty(p.UserID)); err != nil {
			return err
		}
		return fn(TenantTx{db.New(tx), tx, p.TenantID, p.UserID})
	})
}

func uuidOrEmpty(id pgtype.UUID) string {
	if !id.Valid {
		return ""
	}
	return id.String()
}

// ReleaseLocked runs unlock and returns conn to the pool. If unlock fails the connection is closed instead: a
// session-level advisory lock would otherwise stay held on a pooled connection, blocking that work for good.
func ReleaseLocked(conn *pgxpool.Conn, unlock string, args ...any) {
	if _, err := conn.Exec(context.Background(), unlock, args...); err != nil {
		slog.Error("advisory unlock failed; closing the connection so the lock goes with it", "err", err)
		if err := conn.Conn().Close(context.Background()); err != nil {
			slog.Error("closing the connection failed", "err", err)
		}
	}
	conn.Release()
}

// RemoveTemp deletes a temporary directory, logging a failure: leftovers would fill the disk unnoticed.
func RemoveTemp(dir string) {
	if err := os.RemoveAll(dir); err != nil {
		slog.Error("temporary files not removed", "dir", dir, "err", err)
	}
}
