package e2e

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The scheduler hands pieces out fairly, caps a tenant, takes back a piece nobody renews, and writes off one that
// ran out of tries. Pieces are made straight in the database and claimed by hand, so the harness's node stands down.
func TestScheduler(t *testing.T) {
	h := newHarness(t)
	h.stopEncoder()
	owner, err := pgxpool.New(t.Context(), os.Getenv("TEST_OWNER_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	// Fake videos from earlier runs would be picked up by other tests' encoders.
	cleanup := func() {
		if _, err := owner.Exec(t.Context(), `DELETE FROM assets WHERE source_key = 'none'`); err != nil {
			t.Error(err)
		}
	}
	cleanup()
	t.Cleanup(func() { owner.Exec(context.Background(), `DELETE FROM assets WHERE source_key = 'none'`) })

	// A workspace with an asset in the given state holding n pieces of a lane.
	workspace := func(name, lane string, n int) (tenant, asset pgtype.UUID) {
		t.Helper()
		_, key := h.signup(name)
		tenantID := h.call(h.client(), "GET", "/v1/me", key, "", 200)["tenant"].(map[string]any)["id"].(string)
		tenant.Scan(tenantID)
		if _, err := owner.Exec(t.Context(), `INSERT INTO libraries (tenant_id, name, is_default) VALUES ($1, 'Main', true) ON CONFLICT DO NOTHING`, tenantID); err != nil {
			t.Fatal(err)
		}
		if err := owner.QueryRow(t.Context(), `INSERT INTO assets (id, tenant_id, status, source_key, library_id) VALUES (gen_random_uuid(), $1, 'processing', 'none', (SELECT id FROM libraries WHERE tenant_id = $1 AND is_default)) RETURNING id`, tenantID).Scan(&asset); err != nil {
			t.Fatal(err)
		}
		if _, err := owner.Exec(t.Context(), `INSERT INTO encode_tasks (tenant_id, asset_id, lane, chunk) SELECT $1, $2, $3, g FROM generate_series(0, $4 - 1) g`, tenantID, asset, lane, n); err != nil {
			t.Fatal(err)
		}
		return tenant, asset
	}
	claim := func(node string, free int) map[string]int {
		t.Helper()
		rows, err := h.pool.Query(t.Context(), `SELECT tenant_id::text FROM scheduler_claim($1, $2, 8, interval '1 minute', 6)`, node, free)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		got := map[string]int{}
		for rows.Next() {
			var tenant string
			if err := rows.Scan(&tenant); err != nil {
				t.Fatal(err)
			}
			got[tenant]++
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return got
	}

	// Tenants take turns: a big job's full-ladder pieces don't starve a small job's quick ones.
	big, bigAsset := workspace("big", "full", 12)
	small, _ := workspace("small", "fast", 2)
	got := claim("node-a", 4)
	if got[small.String()] != 2 || got[big.String()] != 2 {
		t.Fatalf("first four pieces: %v, want two for each workspace", got)
	}
	// A workspace never runs more than eight at once, however much room there is.
	if got = claim("node-b", 20); got[big.String()] != 6 {
		t.Fatalf("big had 2 running and was given %d more, want 6 (8 in all)", got[big.String()])
	}
	if got = claim("node-c", 20); len(got) != 0 {
		t.Fatalf("a node was given %v while every piece is held or the workspace is at its cap", got)
	}

	// A claim that isn't renewed lapses and the piece goes to another node, counting as a try.
	if _, err := owner.Exec(t.Context(), `UPDATE encode_tasks SET leased_until = now() - interval '1 second' WHERE asset_id = $1 AND node_id = 'node-b'`, bigAsset); err != nil {
		t.Fatal(err)
	}
	if got = claim("node-c", 20); got[big.String()] != 6 {
		t.Fatalf("lapsed pieces were not offered again: %v", got)
	}
	var attempts int
	if err := owner.QueryRow(t.Context(), `SELECT max(attempts) FROM encode_tasks WHERE asset_id = $1 AND node_id = 'node-c'`, bigAsset).Scan(&attempts); err != nil || attempts != 2 {
		t.Fatalf("a reclaimed piece has %d tries (err %v), want 2", attempts, err)
	}

	// A piece given back waits before anyone may take it; one out of tries is reported once.
	var chunk int
	if err := owner.QueryRow(t.Context(), `SELECT min(chunk) FROM encode_tasks WHERE asset_id = $1 AND node_id = 'node-a'`, bigAsset).Scan(&chunk); err != nil {
		t.Fatal(err)
	}
	if _, err := h.pool.Exec(t.Context(), `SELECT scheduler_release($1, 'full', $2, 'node-a', 'boom', interval '10 seconds')`, bigAsset, chunk); err != nil {
		t.Fatal(err)
	}
	var waiting int
	if err := owner.QueryRow(t.Context(), `SELECT count(*) FROM encode_tasks WHERE asset_id = $1 AND node_id IS NULL AND leased_until > now() AND last_error = 'boom'`, bigAsset).Scan(&waiting); err != nil || waiting != 1 {
		t.Fatalf("a released piece should be waiting out its pause: %d (err %v)", waiting, err)
	}
	if _, err := owner.Exec(t.Context(), `UPDATE encode_tasks SET attempts = 6, leased_until = now() - interval '1 second' WHERE asset_id = $1 AND node_id IS NULL`, bigAsset); err != nil {
		t.Fatal(err)
	}
	var out int
	if err := h.pool.QueryRow(t.Context(), `SELECT count(*) FROM scheduler_exhausted(6) WHERE asset_id = $1`, bigAsset).Scan(&out); err != nil || out != 1 {
		t.Fatalf("exhausted videos: %d (err %v), want 1", out, err)
	}
	if _, err := h.pool.Exec(t.Context(), `SELECT scheduler_written_off($1, 6)`, bigAsset); err != nil {
		t.Fatal(err)
	}
	if err := h.pool.QueryRow(t.Context(), `SELECT count(*) FROM scheduler_exhausted(6) WHERE asset_id = $1`, bigAsset).Scan(&out); err != nil || out != 0 {
		t.Fatalf("a written-off video came back: %d (err %v)", out, err)
	}
}
