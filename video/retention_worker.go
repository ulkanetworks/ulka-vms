package video

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/video/db"
)

const cleanupBatch = 500

// Only ever an asset's own directory: {tenant}/{asset}/.
var assetPrefix = regexp.MustCompile(`^[0-9a-f-]{36}/[0-9a-f-]{36}/$`)

type deletePrefixWorker struct {
	river.WorkerDefaults[DeletePrefixArgs]
	*module
}

func (w *deletePrefixWorker) Work(ctx context.Context, job *river.Job[DeletePrefixArgs]) error {
	if !assetPrefix.MatchString(job.Args.Prefix) {
		return river.JobCancel(fmt.Errorf("refusing to delete %q", job.Args.Prefix))
	}
	if err := w.Store.DeletePrefix(ctx, job.Args.Prefix); err != nil {
		return err
	}
	if w.Keys == nil {
		return nil
	}
	return w.Keys.Delete(ctx, strings.Split(job.Args.Prefix, "/")[1])
}

type cleanupWorker struct {
	river.WorkerDefaults[CleanupArgs]
	*module
}

// Work deletes originals past 30 days and expires abandoned uploads, a batch at a time; the next run takes the rest.
func (w *cleanupWorker) Work(ctx context.Context, _ *river.Job[CleanupArgs]) error {
	q := db.New(w.Pool)
	if n, err := q.ExpirePlaybackReports(ctx); err != nil {
		return err
	} else if n > 0 {
		slog.InfoContext(ctx, "retention", "table", "playback_reports", "deleted", n)
	}
	sources, err := q.SourcesDueForDeletion(ctx, cleanupBatch)
	if err != nil {
		return err
	}
	for _, src := range sources {
		for _, key := range []string{src.SourceKey, src.SourceKey + ".info"} {
			if _, err := w.Store.S3.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &w.Store.Bucket, Key: &key}); err != nil {
				return err
			}
		}
		if err := inTenant(ctx, w.Pool, src.TenantID, func(q tx) error { return q.MarkSourceDeleted(ctx, src.AssetID) }); err != nil {
			return err
		}
	}

	uploads, err := q.ExpiredUploads(ctx, cleanupBatch)
	if err != nil {
		return err
	}
	rc := river.ClientFromContext[pgx.Tx](ctx)
	for _, up := range uploads {
		if err := w.Store.DeletePrefix(ctx, up.TenantID.String()+"/"+up.AssetID.String()+"/source/"); err != nil {
			return err
		}
		var jobID pgtype.UUID
		err := inTenant(ctx, w.Pool, up.TenantID, func(q tx) error {
			if n, err := q.ExpireUpload(ctx, up.UploadID); err != nil || n == 0 {
				return err
			}
			if err := core.Emit(ctx, rc, q.TenantTx, "upload.errored", map[string]any{"id": up.UploadID, "asset_id": up.AssetID, "error_code": "upload_expired"}); err != nil {
				return err
			}
			jobID, err = q.IngestJobID(ctx, up.AssetID)
			if errors.Is(err, pgx.ErrNoRows) {
				return nil // never turned into an asset
			}
			return err
		})
		if err != nil {
			return err
		}
		if jobID.Valid {
			if err := w.fail(ctx, AssetRef{TenantID: up.TenantID, AssetID: up.AssetID, JobID: jobID}, "upload_expired"); err != nil {
				return err
			}
		}
	}
	// Videos left in the trash for trashDays are deleted for good.
	due, err := q.TrashedDue(ctx, trashDays)
	if err != nil {
		return err
	}
	for _, d := range due {
		if err := inTenant(ctx, w.Pool, d.TenantID, func(q tx) error { return purge(ctx, w.River, q, d.AssetID) }); err != nil {
			return err
		}
	}
	if len(sources)+len(uploads)+len(due) > 0 {
		slog.Info("cleanup", "sources_deleted", len(sources), "uploads_expired", len(uploads), "trash_purged", len(due))
	}
	return nil
}
