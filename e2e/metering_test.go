package e2e

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/ulkanetworks/ulka-vms/app"
	"github.com/ulkanetworks/ulka-vms/usage"
)

// startMeter runs a worker for the maintenance queue, where the meters run.
func startMeter(t *testing.T, h *harness) *river.Client[pgx.Tx] {
	w, err := app.NewWorkerClient(h.pool, h.store, h.cfg, map[string]river.QueueConfig{"maintenance": {MaxWorkers: 1}}, app.Extension{})
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { w.Stop(context.Background()) })
	return w
}

func TestVideoDeliveryMetering(t *testing.T) {
	h := newHarness(t)
	a, _ := h.signup("deliverya")
	b, _ := h.signup("deliveryb")
	tenant := h.call(a, "GET", "/v1/me", "", "", 200)["tenant"].(map[string]any)["id"].(string)
	seg := func(tenant string, status, bytes int) string {
		return fmt.Sprintf(`{"ts":%q,"client_addr":"198.51.100.7","method":"GET","uri":"/s/%s/%s/360p/0.m4s","status":%d,"body_bytes":%d,"request_time":0.01,"user_agent":"test","referer":""}`,
			time.Now().UTC().Format(time.DateTime), tenant, tenant, status, bytes)
	}
	// Two served segments count; a 404, a path outside /s/ and a tenant that doesn't exist don't.
	lines := []string{seg(tenant, 200, 1000), seg(tenant, 206, 500), seg(tenant, 404, 50),
		seg("00000000-0000-0000-0000-000000000000", 200, 777),
		strings.Replace(seg(tenant, 200, 999), `"/s/`, `"/other/`, 1)}
	req, _ := http.NewRequest("POST", h.cfg.ClickHouseURL, strings.NewReader("INSERT INTO origin_access_logs FORMAT JSONEachRow\n"+strings.Join(lines, "\n")))
	if res, err := chDo(req); err != nil {
		t.Fatal(err)
	} else if res != "" {
		t.Fatalf("clickhouse insert: %s", res)
	}

	w := startMeter(t, h)
	totals := func(c *http.Client) string {
		out := map[string]float64{}
		for _, r := range h.call(c, "GET", "/v1/usage", "", "", 200)["totals"].([]any) {
			m := r.(map[string]any)
			out[m["meter"].(string)] = m["quantity"].(float64)
		}
		return fmt.Sprint(out)
	}
	for run := 1; run <= 2; run++ { // a second run recomputes the same hours and must not double count
		if _, err := w.Insert(t.Context(), usage.LogMeterArgs{}, nil); err != nil {
			t.Fatal(err)
		}
		eventually(t, "delivery metered", func() bool { return totals(a) == "map[video_delivery_bytes:1500 video_delivery_requests:2]" })
	}
	if got := totals(b); got != "map[]" {
		t.Fatalf("tenant B sees usage: %v", got)
	}
}

func chDo(req *http.Request) (string, error) {
	if u := req.URL.User; u != nil {
		pw, _ := u.Password()
		req.SetBasicAuth(u.Username(), pw)
		req.URL.User = nil
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		b := new(strings.Builder)
		fmt.Fprint(b, res.Status)
		return b.String(), nil
	}
	return "", nil
}
