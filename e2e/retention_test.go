package e2e

import (
	"bytes"
	"context"
	"crypto/rand"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ulkanetworks/ulka-vms/app"
	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/video"
)

func TestDeleteAndRetention(t *testing.T) {
	h := newHarness(t)
	worker, err := app.NewWorkerClient(h.pool, h.store, h.cfg, app.Queues, app.Extension{})
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { worker.Stop(context.Background()) })

	clip := filepath.Join(t.TempDir(), "in.mp4")
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25", "-t", "3", "-pix_fmt", "yuv420p", clip).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v %s", err, out)
	}
	good, _ := os.ReadFile(clip)
	c := h.client()
	_, key := h.signup("retain")
	_, keyB := h.signup("intruder")
	tenant := h.call(c, "GET", "/v1/me", key, "", 200)["tenant"].(map[string]any)["id"].(string)
	var tenantID pgtype.UUID
	tenantID.Scan(tenant)

	encoded := func() (string, string) {
		t.Helper()
		up := h.call(c, "POST", "/v1/uploads", key, "", 201)
		a := h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+up["id"].(string)+`","playback_policy":"public"}`, 201)
		h.sendUpload(up, good, http.StatusOK)
		id := a["id"].(string)
		for start := time.Now(); a["status"] != "complete" && time.Since(start) < time.Minute; time.Sleep(200 * time.Millisecond) {
			a = h.call(c, "GET", "/v1/assets/"+id, key, "", 200)
		}
		if a["status"] != "complete" {
			t.Fatalf("asset: %v", a)
		}
		return id, h.playPath(a)
	}
	objects := func(prefix string) int {
		t.Helper()
		res, err := h.store.S3.ListObjectsV2(t.Context(), &s3.ListObjectsV2Input{Bucket: &h.store.Bucket, Prefix: &prefix})
		if err != nil {
			t.Fatal(err)
		}
		return len(res.Contents)
	}
	eventually := func(what string, ok func() bool) {
		t.Helper()
		for start := time.Now(); time.Since(start) < 30*time.Second; time.Sleep(200 * time.Millisecond) {
			if ok() {
				return
			}
		}
		t.Fatalf("timed out waiting for %s", what)
	}
	inT := func(fn func(q core.TenantTx) error) {
		t.Helper()
		if err := core.InTenant(t.Context(), h.pool, tenantID, fn); err != nil {
			t.Fatal(err)
		}
	}

	// Delete: rows, playback and storage all go; another tenant cannot do it.
	gone, pid := encoded()
	prefix := tenant + "/" + gone + "/"
	h.call(c, "DELETE", "/v1/assets/"+gone, keyB, "", 404)
	h.call(c, "DELETE", "/v1/assets/"+gone, key, "", 204)
	h.call(c, "GET", "/v1/assets/"+gone, key, "", 404)
	h.call(c, "DELETE", "/v1/assets/"+gone, key, "", 404)
	if res, _ := h.ts.Client().Get(h.ts.URL + pid + "/playlist.m3u8"); res.StatusCode != 404 {
		t.Fatalf("playback after delete: %d", res.StatusCode)
	}
	eventually("storage of the deleted asset to empty", func() bool { return objects(prefix) == 0 })
	var late int
	h.pool.QueryRow(t.Context(), `SELECT count(*) FROM river.river_job WHERE kind = 'delete_prefix' AND args->>'prefix' = $1
		AND scheduled_at > now() + interval '4 hours'`, prefix).Scan(&late)
	if late != 1 {
		t.Fatalf("want the late second deletion pass scheduled, got %d", late)
	}

	// Deleting mid-encode: the asset's jobs cancel rather than retry.
	up := h.call(c, "POST", "/v1/uploads", key, "", 201)
	mid := h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+up["id"].(string)+`"}`, 201)["id"].(string)
	h.sendUpload(up, good, http.StatusOK)
	h.call(c, "DELETE", "/v1/assets/"+mid, key, "", 204)
	eventually("jobs of the deleted asset to settle", func() bool {
		var open int
		h.pool.QueryRow(t.Context(), `SELECT count(*) FROM river.river_job WHERE args->>'asset_id' = $1 AND state NOT IN ('completed', 'cancelled')`, mid).Scan(&open)
		return open == 0
	})

	// Retention: after 30 days only the original goes; playback keeps working.
	kept, keptPID := encoded()
	var keptID pgtype.UUID
	keptID.Scan(kept)
	inT(func(q core.TenantTx) error {
		_, err := q.Exec(t.Context(), "UPDATE assets SET created_at = now() - interval '31 days' WHERE id = $1", keptID)
		return err
	})

	// Expiry: one reserved upload never started, one started and stalled with a real multipart part in S3.
	never := h.call(c, "POST", "/v1/uploads", key, "", 201)
	neverAsset := h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+never["id"].(string)+`"}`, 201)["id"].(string)
	stalled := h.call(c, "POST", "/v1/uploads", key, "", 201)
	stalledAsset := h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+stalled["id"].(string)+`"}`, 201)["id"].(string)
	h.partialUpload(stalled, 20<<20, 6<<20)
	stalledPrefix := tenant + "/" + stalledAsset + "/source/"
	if parts, _ := h.store.S3.ListMultipartUploads(t.Context(), &s3.ListMultipartUploadsInput{Bucket: &h.store.Bucket, Prefix: &stalledPrefix}); len(parts.Uploads) != 1 {
		t.Fatalf("want one open multipart upload for the stalled upload, got %d", len(parts.Uploads))
	}
	inT(func(q core.TenantTx) error {
		if _, err := q.Exec(t.Context(), "UPDATE uploads SET expires_at = now() - interval '1 minute' WHERE id = $1", never["id"]); err != nil {
			return err
		}
		_, err := q.Exec(t.Context(), "UPDATE uploads SET created_at = now() - interval '8 days' WHERE id = $1", stalled["id"])
		return err
	})

	if _, err := worker.Insert(t.Context(), video.CleanupArgs{}, nil); err != nil {
		t.Fatal(err)
	}
	eventually("the kept asset's original to be deleted", func() bool {
		var deleted bool
		inT(func(q core.TenantTx) error {
			return q.QueryRow(t.Context(), "SELECT source_deleted_at IS NOT NULL FROM assets WHERE id = $1", keptID).Scan(&deleted)
		})
		return deleted
	})
	keptPrefix := tenant + "/" + kept + "/"
	if n := objects(keptPrefix + "source/"); n != 0 {
		t.Fatalf("original still stored: %d objects", n)
	}
	if objects(keptPrefix+"360p/") == 0 {
		t.Fatal("retention removed renditions too")
	}
	if res, _ := h.ts.Client().Get(h.ts.URL + keptPID + "/playlist.m3u8"); res.StatusCode != 200 {
		t.Fatalf("playback after retention: %d", res.StatusCode)
	}

	for _, id := range []string{neverAsset, stalledAsset} {
		var a map[string]any
		eventually("expired asset "+id+" to error", func() bool {
			a = h.call(c, "GET", "/v1/assets/"+id, key, "", 200)
			return a["status"] == "errored"
		})
		if a["error_code"] != "upload_expired" {
			t.Fatalf("expired asset: %v", a)
		}
		if job := h.call(c, "GET", "/v1/assets/"+id+"/jobs", key, "", 200)["data"].([]any)[0].(map[string]any); job["status"] != "failed" || job["error_code"] != "upload_expired" {
			t.Fatalf("expired asset job: %v", job)
		}
	}
	if parts, _ := h.store.S3.ListMultipartUploads(t.Context(), &s3.ListMultipartUploadsInput{Bucket: &h.store.Bucket, Prefix: &stalledPrefix}); len(parts.Uploads) != 0 || objects(stalledPrefix) != 0 {
		t.Fatalf("stalled upload left %d multipart uploads, %d objects", len(parts.Uploads), objects(stalledPrefix))
	}
	h.sendUpload(never, good, http.StatusNotFound)
}

// partialUpload declares total bytes and sends only the first sent of them, as an upload that stalled.
func (h *harness) partialUpload(up map[string]any, total, sent int) {
	h.t.Helper()
	chunk := make([]byte, sent)
	rand.Read(chunk)
	req, _ := http.NewRequest("PUT", up["upload_url"].(string), bytes.NewReader(chunk))
	req.Header.Set("Content-Range", fmt.Sprintf("bytes 0-%d/%d", sent-1, total))
	res, err := h.ts.Client().Do(req)
	if err != nil || res.StatusCode != http.StatusOK {
		h.t.Fatalf("first part: %v %v", res, err)
	}
	res.Body.Close()
}
