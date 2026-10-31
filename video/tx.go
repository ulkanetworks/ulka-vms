package video

import (
	"context"
	"net/http"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/video/db"
)

// tx is a tenant transaction carrying this module's queries; core's are reached through TenantTx.
type tx struct {
	core.TenantTx
	*db.Queries
}

func with(t core.TenantTx) tx { return tx{t, db.New(t.Tx)} }

func inTenant(ctx context.Context, pool *pgxpool.Pool, tenant pgtype.UUID, fn func(tx) error) error {
	return core.InTenant(ctx, pool, tenant, func(t core.TenantTx) error { return fn(with(t)) })
}

func inScope(ctx context.Context, pool *pgxpool.Pool, p core.Principal, fn func(tx) error) error {
	return core.InScope(ctx, pool, p, func(t core.TenantTx) error { return fn(with(t)) })
}

func withPathID(d *core.Deps, r *http.Request, p core.Principal, fn func(tx, pgtype.UUID) error) error {
	return d.WithPathID(r, p, func(t core.TenantTx, id pgtype.UUID) error { return fn(with(t), id) })
}
