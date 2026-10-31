package transcoder

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
)

func PeriodicJobs() []*river.PeriodicJob {
	return []*river.PeriodicJob{river.NewPeriodicJob(river.PeriodicInterval(30*time.Second),
		func() (river.JobArgs, *river.InsertOpts) { return SweepArgs{}, nil }, nil)}
}

// loadWork reads the video's source, plan and keys through the hooks.
func (d *module) loadWork(ctx context.Context, ref AssetRef) (Work, Plan, error) {
	work, err := d.hooks.Work(ctx, ref)
	if err != nil {
		return work, Plan{}, err
	}
	var p Plan
	if len(work.Plan) > 0 {
		err = json.Unmarshal(work.Plan, &p)
	}
	return work, p, err
}

// retryOrFail hands err back to River while attempts remain; on the last one it fails the video.
func (d *module) retryOrFail(ctx context.Context, job *rivertype.JobRow, ref AssetRef, code string, err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return river.JobCancel(fmt.Errorf("asset deleted: %w", err))
	}
	if job.Attempt < job.MaxAttempts {
		return err
	}
	slog.Error("job gave up", "kind", job.Kind, "asset", ref.AssetID, "err", err)
	return d.fail(ctx, ref, code)
}

// fail reports the video failed and stops handing out its pieces.
func (d *module) fail(ctx context.Context, ref AssetRef, code string) error {
	if err := d.hooks.Failed(ctx, ref, code); err != nil {
		return err
	}
	return inTenant(ctx, d.Pool, ref.TenantID, func(q tx) error { return q.WriteOffTasks(ctx, ref.AssetID) })
}

func workKey(ref AssetRef, name string) string { return Prefix(ref) + "work/" + name }
