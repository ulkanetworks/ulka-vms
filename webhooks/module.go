package webhooks

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/riverqueue/river"
	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/webhooks/db"
)

type module struct{ *core.Deps }

func Routes(mux *http.ServeMux, d *core.Deps) {
	s := &module{d}
	mux.HandleFunc("POST /v1/webhook-endpoints", s.Auth("webhooks:write", s.createWebhookEndpoint))
	mux.HandleFunc("GET /v1/webhook-endpoints", s.Auth("webhooks:read", s.listWebhookEndpoints))
	mux.HandleFunc("GET /v1/webhook-endpoints/{id}", s.Auth("webhooks:read", s.showWebhookEndpoint))
	mux.HandleFunc("PATCH /v1/webhook-endpoints/{id}", s.Auth("webhooks:write", s.updateWebhookEndpoint))
	mux.HandleFunc("DELETE /v1/webhook-endpoints/{id}", s.Auth("webhooks:write", s.deleteWebhookEndpoint))
	mux.HandleFunc("GET /v1/webhook-endpoints/{id}/deliveries", s.Auth("webhooks:read", s.listDeliveries))
	mux.HandleFunc("POST /v1/webhook-endpoints/{id}/deliveries/{deliveryId}/retry", s.Auth("webhooks:write", s.retryDelivery))
}

func Workers(w *river.Workers, d *core.Deps) {
	river.AddWorker(w, &deliverWorker{module: &module{d}})
	river.AddWorker(w, &fanoutWorker{module: &module{d}})
	river.AddWorker(w, &retentionWorker{module: &module{d}})
}

// RetentionArgs deletes delivery history past 30 days, daily.
type RetentionArgs struct{}

func (RetentionArgs) Kind() string { return "retention_webhooks" }
func (RetentionArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: "maintenance", MaxAttempts: 3}
}

type retentionWorker struct {
	river.WorkerDefaults[RetentionArgs]
	*module
}

func (w *retentionWorker) Work(ctx context.Context, _ *river.Job[RetentionArgs]) error {
	n, err := db.New(w.Pool).RetentionWebhooks(ctx)
	slog.Info("retention", "webhook_deliveries", n)
	return err
}

func PeriodicJobs() []*river.PeriodicJob {
	return []*river.PeriodicJob{river.NewPeriodicJob(river.PeriodicInterval(24*time.Hour),
		func() (river.JobArgs, *river.InsertOpts) { return RetentionArgs{}, nil }, &river.PeriodicJobOpts{RunOnStart: true})}
}
