package core

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ulkanetworks/ulka-vms/core/db"
)

// RecordUsage writes one usage record in the caller's transaction; recording the same (meter, key) again
// replaces its quantity, so re-runs never double count. quantity is a decimal string.
func RecordUsage(ctx context.Context, q TenantTx, meter, key string, at time.Time, region, quantity string) error {
	var n pgtype.Numeric
	if err := n.Scan(quantity); err != nil {
		return err
	}
	return q.RecordUsage(ctx, db.RecordUsageParams{Meter: meter, Key: key, At: pgtype.Timestamptz{Time: at, Valid: true}, Region: region, Quantity: n})
}
