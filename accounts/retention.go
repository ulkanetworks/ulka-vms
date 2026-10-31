package accounts

import (
	"context"
	"log/slog"
	"time"

	"github.com/riverqueue/river"

	"github.com/ulkanetworks/ulka-vms/core"
	coredb "github.com/ulkanetworks/ulka-vms/core/db"
)

// RetentionArgs deletes the kernel's rows past their use each day: expired sessions, email tokens and invites, and
// usage older than reports reach. Each module cleans its own tables.
type RetentionArgs struct{}

func (RetentionArgs) Kind() string { return "retention_core" }

func (RetentionArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: "maintenance", MaxAttempts: 3}
}

type retentionWorker struct {
	river.WorkerDefaults[RetentionArgs]
	*core.Deps
}

func (w *retentionWorker) Work(ctx context.Context, _ *river.Job[RetentionArgs]) error {
	rows, err := coredb.New(w.Pool).RetentionCore(ctx)
	for _, r := range rows {
		slog.InfoContext(ctx, "retention", "table", r.Tbl, "deleted", r.Deleted)
	}
	return err
}

// Workers registers the daily retention.
func Workers(w *river.Workers, d *core.Deps) { river.AddWorker(w, &retentionWorker{Deps: d}) }

func PeriodicJobs() []*river.PeriodicJob {
	return []*river.PeriodicJob{river.NewPeriodicJob(river.PeriodicInterval(24*time.Hour),
		func() (river.JobArgs, *river.InsertOpts) { return RetentionArgs{}, nil }, &river.PeriodicJobOpts{RunOnStart: true})}
}
