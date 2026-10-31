package video

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/video/db"
)

// Workers registers the video module's River workers; the encode pipeline's are the transcoder's.
func Workers(w *river.Workers, d *core.Deps) {
	m := &module{Deps: d}
	river.AddWorker(w, &fetchWorker{module: m})
	river.AddWorker(w, &downloadWorker{module: m})
	river.AddWorker(w, &deletePrefixWorker{module: m})
	river.AddWorker(w, &cleanupWorker{module: m})
}

func PeriodicJobs() []*river.PeriodicJob {
	return []*river.PeriodicJob{river.NewPeriodicJob(river.PeriodicInterval(time.Hour),
		func() (river.JobArgs, *river.InsertOpts) { return CleanupArgs{}, nil }, &river.PeriodicJobOpts{RunOnStart: true})}
}

// retryOrFail hands err back to River while attempts remain; on the last one it fails the ingest job.
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

// fail errors the asset only if nothing is playable yet, and marks the ingest job failed.
func (d *module) fail(ctx context.Context, ref AssetRef, code string) error {
	rc := d.River
	return inTenant(ctx, d.Pool, ref.TenantID, func(q tx) error {
		errCode := pgtype.Text{String: code, Valid: true}
		n, err := q.FailAssetIfUnplayable(ctx, db.FailAssetIfUnplayableParams{ID: ref.AssetID, ErrorCode: errCode})
		if err != nil {
			return err
		}
		if n == 1 {
			if err := EmitAsset(ctx, rc, q, "asset.errored", ref.AssetID); err != nil {
				return err
			}
		}
		if n, err = q.FinishJob(ctx, db.FinishJobParams{ID: ref.JobID, Status: "failed", ErrorCode: errCode}); err != nil || n == 0 {
			return err
		}
		return EmitJob(ctx, rc, q, "job.failed", ref.JobID)
	})
}
