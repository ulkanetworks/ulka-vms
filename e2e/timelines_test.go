package e2e

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ulkanetworks/ulka-vms/app"
	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/webhooks"
)

func startWorker(t *testing.T, h *harness) {
	t.Helper()
	w, err := app.NewWorkerClient(h.pool, h.store, h.cfg, app.Queues, app.Extension{})
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { w.Stop(context.Background()) })
}

func ownerPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	p, err := pgxpool.New(t.Context(), os.Getenv("TEST_OWNER_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	return p
}

func list(t *testing.T, h *harness, c *http.Client, path string) map[string]any {
	t.Helper()
	return h.call(c, "GET", path, "", "", 200)
}

// Each event sent to an endpoint is kept with what happened; a failed one can be sent again.
func TestWebhookDeliveries(t *testing.T) {
	h := newHarness(t)
	var answer atomic.Int32
	answer.Store(500)
	recv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(int(answer.Load()))
		w.Write([]byte("secret-receiver-words"))
	}))
	defer recv.Close()
	saved := webhooks.WebhookClient
	webhooks.WebhookClient = recv.Client()
	t.Cleanup(func() { webhooks.WebhookClient = saved })
	webhooks.CheckHost = func(context.Context, string) error { return nil }
	t.Cleanup(func() { webhooks.CheckHost = core.CheckPublicHost })
	startWorker(t, h)

	c := h.client()
	_, key := h.signup("deliveries")
	_, bystander := h.signup("deliveriesother")
	ep := h.call(c, "POST", "/v1/webhook-endpoints", key, `{"url":"`+recv.URL+`/hook"}`, 201)["id"].(string)
	base := "/v1/webhook-endpoints/" + ep + "/deliveries"
	up := h.call(c, "POST", "/v1/uploads", key, "", 201)
	h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+up["id"].(string)+`"}`, 201)

	first := func() map[string]any {
		d := h.call(c, "GET", base, key, "", 200)["data"].([]any)
		if len(d) == 0 {
			return nil
		}
		return d[0].(map[string]any)
	}
	eventually(t, "a failed attempt", func() bool { d := first(); return d != nil && d["status"] == "retrying" })
	d := first()
	if d["event"] != "asset.created" || d["status_code"] != float64(500) || d["attempts"] != float64(1) ||
		d["failure"] != "Your endpoint answered with an error." || d["next_attempt_at"] == nil {
		t.Fatalf("delivery: %v", d)
	}
	if b, _ := json.Marshal(d); strings.Contains(string(b), "secret-receiver-words") {
		t.Fatal("the endpoint's own answer is shown")
	}
	h.call(c, "GET", base, bystander, "", 404)
	h.call(c, "POST", base+"/"+d["id"].(string)+"/retry", key, "", 202) // still being retried: answers, queues nothing more

	// The job gives up (here: simulated), then the customer sends it again once their endpoint works.
	if _, err := ownerPool(t).Exec(t.Context(), `UPDATE webhook_deliveries SET status = 'failed' WHERE id = $1`, d["id"]); err != nil {
		t.Fatal(err)
	}
	answer.Store(200)
	h.call(c, "POST", base+"/"+d["id"].(string)+"/retry", bystander, "", 404)
	h.call(c, "POST", base+"/"+d["id"].(string)+"/retry", key, "", 202)
	eventually(t, "delivered", func() bool { d := first(); return d["status"] == "done" })
	if d := first(); d["status_code"] != float64(200) || d["failure"] != "" || d["attempts"].(float64) < 2 || d["next_attempt_at"] != nil {
		t.Fatalf("after retry: %v", d)
	}
	h.call(c, "POST", base+"/"+d["id"].(string)+"/retry", key, "", 409)
}

// A video that failed is processed again from its kept original; one that didn't fail, or is gone, is refused.
func TestRetryFailedVideo(t *testing.T) {
	h := newHarness(t)
	startWorker(t, h)
	c := h.client()
	_, key := h.signup("retryvideo")
	_, other := h.signup("retryvideoother")
	up := h.call(c, "POST", "/v1/uploads", key, "", 201)
	id := h.call(c, "POST", "/v1/assets", key, `{"upload_id":"`+up["id"].(string)+`"}`, 201)["id"].(string)
	h.sendUpload(up, []byte("garbage"), http.StatusOK)
	h.waitFor(key, "/v1/assets/"+id, func(a map[string]any) bool { return a["status"] == "errored" })

	h.call(c, "POST", "/v1/assets/"+id+"/retry", other, "", 404)
	h.call(c, "POST", "/v1/assets/00000000-0000-4000-8000-000000000000/retry", key, "", 404)
	got := h.call(c, "POST", "/v1/assets/"+id+"/retry", key, "", 202)
	if got["status"] != "processing" || got["error_code"] != nil && got["error_code"] != "" {
		t.Fatalf("after retry: %v", got)
	}
	h.call(c, "POST", "/v1/assets/"+id+"/retry", key, "", 202) // a double click answers the same or the new failure; never an error
	// The garbage is still garbage, so it fails again: the job really ran a second time.
	h.waitFor(key, "/v1/assets/"+id, func(a map[string]any) bool { return a["status"] == "errored" })

	// With the original gone there is nothing to process again.
	var srcKey string
	if err := ownerPool(t).QueryRow(t.Context(), `SELECT source_key FROM assets WHERE id = $1`, id).Scan(&srcKey); err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.S3.DeleteObject(t.Context(), &s3.DeleteObjectInput{Bucket: &h.store.Bucket, Key: &srcKey}); err != nil {
		t.Fatal(err)
	}
	e := h.call(c, "POST", "/v1/assets/"+id+"/retry", key, "", 409)["error"].(map[string]any)
	if e["code"] != "asset_not_retryable" {
		t.Fatalf("error: %v", e)
	}
}
