package e2e

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/ulkanetworks/ulka-vms/accounts"
	"github.com/ulkanetworks/ulka-vms/app"
)

// The worker's daily retention deletes only what's past its use: an expired session and 401-day-old usage go, current ones stay.
func TestRetentionDeletesOnlyOldRows(t *testing.T) {
	h := newHarness(t)
	a, _ := h.signup("retain")
	tenant := h.call(a, "GET", "/v1/me", "", "", 200)["tenant"].(map[string]any)["id"].(string)
	owner, err := pgx.Connect(t.Context(), os.Getenv("TEST_OWNER_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close(context.Background())
	for _, sql := range []string{
		`INSERT INTO sessions (token_hash, tenant_id, user_id, expires_at) SELECT convert_to('old-' || gen_random_uuid(), 'UTF8'), $1, user_id, now() - interval '1 minute' FROM tenant_members WHERE tenant_id = $1`,
		`INSERT INTO usage_records (tenant_id, meter, key, period, region, quantity) VALUES ($1, 'video_delivery_requests', 'old-' || gen_random_uuid(), date_trunc('hour', now()) - interval '401 days', '', 1),
		 ($1, 'video_delivery_requests', 'new-' || gen_random_uuid(), date_trunc('hour', now()) - interval '1 day', '', 1)`,
	} {
		if _, err := owner.Exec(t.Context(), sql, tenant); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	w, err := app.NewWorkerClient(h.pool, h.store, h.cfg, map[string]river.QueueConfig{"maintenance": {MaxWorkers: 1}}, app.Extension{})
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { w.Stop(context.Background()) })
	// The worker runs it on start, as each day after; asking again just runs it once more.
	if _, err := w.Insert(t.Context(), accounts.RetentionArgs{}, nil); err != nil {
		t.Fatal(err)
	}
	count := func(sql string) (n int) {
		if err := owner.QueryRow(t.Context(), sql, tenant).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	eventually(t, "expired sessions deleted", func() bool {
		return count(`SELECT count(*) FROM sessions WHERE tenant_id = $1 AND expires_at < now()`) == 0
	})
	if n := count(`SELECT count(*) FROM sessions WHERE tenant_id = $1`); n == 0 {
		t.Error("the live session was deleted")
	}
	if old, recent := count(`SELECT count(*) FROM usage_records WHERE tenant_id = $1 AND key LIKE 'old-%'`),
		count(`SELECT count(*) FROM usage_records WHERE tenant_id = $1 AND key LIKE 'new-%'`); old != 0 || recent != 1 {
		t.Errorf("usage: old %d, recent %d", old, recent)
	}
}
