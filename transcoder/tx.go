package transcoder

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/transcoder/db"
)

// tx is a tenant transaction carrying this module's queries.
type tx struct {
	core.TenantTx
	*db.Queries
}

func with(t core.TenantTx) tx { return tx{t, db.New(t.Tx)} }

func inTenant(ctx context.Context, pool *pgxpool.Pool, tenant pgtype.UUID, fn func(tx) error) error {
	return core.InTenant(ctx, pool, tenant, func(t core.TenantTx) error { return fn(with(t)) })
}
