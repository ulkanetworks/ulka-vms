package e2e

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
)

// A library reports its storage and its videos by state, and a video its size; another workspace's videos never count.
func TestLibraryStats(t *testing.T) {
	h := newHarness(t)
	c, key := h.signup("libstats")
	other, _ := h.signup("libstats-other")
	owner, err := pgx.Connect(t.Context(), os.Getenv("TEST_OWNER_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close(context.Background())

	lib := h.call(c, "GET", "/v1/libraries", "", "", 200)["data"].([]any)[0].(map[string]any)["id"].(string)
	otherLib := h.call(other, "GET", "/v1/libraries", "", "", 200)["data"].([]any)[0].(map[string]any)["id"].(string)
	add := func(libraryID, status, size string, trashed bool) string {
		t.Helper()
		var id string
		err := owner.QueryRow(t.Context(), `INSERT INTO assets (id, tenant_id, status, source_key, probe, library_id, deleted_at)
			SELECT gen_random_uuid(), tenant_id, $2, 'k', CASE WHEN $3 = '' THEN NULL ELSE jsonb_build_object('format', jsonb_build_object('size', $3::text)) END, id,
			       CASE WHEN $4 THEN now() END FROM libraries WHERE id = $1 RETURNING id::text`, libraryID, status, size, trashed).Scan(&id)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	done := add(lib, "complete", "1000", false)
	add(lib, "processing", "200", false)
	add(lib, "waiting", "", false)
	add(lib, "errored", "30", false)
	add(lib, "complete", "5000", true) // in the trash: counts for nothing
	add(otherLib, "complete", "7777", false)

	got := h.call(c, "GET", "/v1/libraries/"+lib, "", "", 200)
	by := got["by_status"].(map[string]any)
	if got["storage_bytes"] != 1230.0 || by["all"] != 4.0 || by["ready"] != 1.0 || by["processing"] != 2.0 || by["errored"] != 1.0 || got["trashed"] != 1.0 {
		t.Fatalf("library stats: %v", got)
	}
	if v := h.call(c, "GET", "/v1/assets/"+done, key, "", 200); v["size_bytes"] != 1000.0 {
		t.Fatalf("video size: %v", v["size_bytes"])
	}
	if n := len(h.call(c, "GET", "/v1/assets?library_id="+lib+"&status=waiting,processing,ready", key, "", 200)["data"].([]any)); n != 2 {
		t.Fatalf("processing filter found %d", n)
	}
	h.call(c, "GET", "/v1/assets?status=waiting,nope", key, "", 400)
}
