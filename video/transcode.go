package video

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/transcoder"
	"github.com/ulkanetworks/ulka-vms/video/db"
)

// Hooks is how the transcoder asks about videos and reports on them (transcoder.Hooks): this module keeps the
// records, the transcoder does the encoding, and neither reaches into the other's tables.
func Hooks(d *core.Deps) transcoder.Hooks { return &module{Deps: d} }

func (d *module) Work(ctx context.Context, ref AssetRef) (transcoder.Work, error) {
	var out transcoder.Work
	err := inTenant(ctx, d.Pool, ref.TenantID, func(q tx) error {
		w, err := q.GetAssetWork(ctx, ref.AssetID)
		if err != nil {
			return err
		}
		preset, err := q.AssetPreset(ctx, ref.AssetID)
		if err != nil {
			return err
		}
		out = transcoder.Work{SourceKey: w.SourceKey, DurationSeconds: w.DurationSeconds.Float64, Plan: w.Plan, IV: w.EncryptionIv, Preset: presetOf(preset)}
		if w.EncryptionKey != nil {
			out.Key, err = core.Open(d.SealKey, w.EncryptionKey)
		}
		return err
	})
	// An IV without a stored key means the plan's key is in the key service (core.KeyStore).
	if err == nil && out.Key == nil && out.IV != nil {
		if d.Keys == nil {
			return out, errors.New("video's key is in the key service, and KEY_SERVICE is local")
		}
		out.Key, _, err = d.Keys.Get(ctx, ref.AssetID.String())
	}
	return out, err
}

func (d *module) Started(ctx context.Context, ref AssetRef) error {
	return inTenant(ctx, d.Pool, ref.TenantID, func(q tx) error {
		n, err := q.StartJob(ctx, ref.JobID)
		if err != nil || n == 0 {
			return err
		}
		if err := q.StartTimeline(ctx, ref.AssetID); err != nil {
			return err
		}
		return EmitJob(ctx, d.River, q, "job.started", ref.JobID)
	})
}

// Admit refuses a video that would take the workspace past its month's encoding minutes: those already encoded,
// plus videos still encoding, plus this one.
func (d *module) Admit(ctx context.Context, t core.TenantTx, ref AssetRef, seconds float64) (string, error) {
	limits, err := core.LimitsFor(ctx, t)
	if err != nil {
		return "", err
	}
	used, err := MinutesCommitted(ctx, t, ref.AssetID)
	if err == nil && used+seconds/60 > float64(limits.EncodeMinutesMonthly) {
		return core.ErrEncodeLimitReached, nil
	}
	return "", err
}

func (d *module) Planned(ctx context.Context, t core.TenantTx, ref AssetRef, p transcoder.Planned) error {
	q := with(t)
	if err := q.SetAssetProbe(ctx, db.SetAssetProbeParams{
		ID: ref.AssetID, Probe: p.Probe,
		DurationSeconds: pgtype.Float8{Float64: p.Duration, Valid: true},
		Width:           pgtype.Int4{Int32: int32(p.Width), Valid: true},
		Height:          pgtype.Int4{Int32: int32(p.Height), Valid: true},
	}); err != nil {
		return err
	}
	if d.Keys != nil {
		_, iv, err := d.Keys.Create(ctx, ref.AssetID.String())
		if err != nil {
			return err
		}
		return q.SetAssetPlan(ctx, db.SetAssetPlanParams{ID: ref.AssetID, Plan: p.Plan, EncryptionIv: iv})
	}
	sealedKey, err := core.Seal(d.SealKey, p.Key)
	if err != nil {
		return err
	}
	return q.SetAssetPlan(ctx, db.SetAssetPlanParams{ID: ref.AssetID, Plan: p.Plan, EncryptionKey: sealedKey, EncryptionIv: p.IV})
}

func (d *module) Failed(ctx context.Context, ref AssetRef, code string) error {
	return d.fail(ctx, ref, code)
}

// Publish puts the master playlist in place and marks the video, under the video's lock so a viewer never sees a
// half-published ladder. At "ready" the fast qualities play; at "complete" every quality does, the encode is
// billed once, a waiting MP4 download is made, and the ingest job finishes.
func (d *module) Publish(ctx context.Context, ref AssetRef, stage string, upload func(context.Context) error) error {
	return inTenant(ctx, d.Pool, ref.TenantID, func(q tx) error {
		status, err := q.LockAsset(ctx, ref.AssetID)
		if err != nil {
			return err
		}
		if stage == "ready" && status != "processing" {
			return nil // the full ladder already published, or the asset failed
		}
		if err := upload(ctx); err != nil {
			return err
		}
		rc := d.River
		if stage == "ready" {
			if n, err := q.MarkAssetReady(ctx, ref.AssetID); err != nil || n == 0 {
				return err
			}
			return EmitAsset(ctx, rc, q, "asset.ready", ref.AssetID)
		}
		return d.complete(ctx, rc, q, ref, status)
	})
}

func (d *module) complete(ctx context.Context, rc *river.Client[pgx.Tx], q tx, ref AssetRef, was string) error {
	if n, err := q.MarkAssetComplete(ctx, ref.AssetID); err != nil || n == 0 {
		return err
	}
	// The full ladder is what we bill as encoded; it is recorded once per asset, when it completes.
	asset, err := q.GetAsset(ctx, ref.AssetID)
	if err != nil {
		return err
	}
	minutes := strconv.FormatFloat(asset.DurationSeconds.Float64/60, 'f', 4, 64)
	if err := core.RecordUsage(ctx, q.TenantTx, "video_minutes_encoded", ref.AssetID.String(), time.Now(), "", minutes); err != nil {
		return err
	}
	// Straight to complete still tells the customer it became playable.
	if was == "processing" {
		if err := EmitAsset(ctx, rc, q, "asset.ready", ref.AssetID); err != nil {
			return err
		}
	}
	// A download asked for before it finished is made now, from what was just published.
	if asset.Download.String == "preparing" {
		if _, err := rc.InsertTx(ctx, q.Tx, MakeDownloadArgs{ref.TenantID, ref.AssetID}, nil); err != nil {
			return err
		}
	}
	if err := EmitAsset(ctx, rc, q, "asset.complete", ref.AssetID); err != nil {
		return err
	}
	if n, err := q.FinishJob(ctx, db.FinishJobParams{ID: ref.JobID, Status: "completed"}); err != nil || n == 0 {
		return err
	}
	return EmitJob(ctx, rc, q, "job.completed", ref.JobID)
}

// SourceKey is where a video's original is stored.
func SourceKey(tenantID, assetID pgtype.UUID) string {
	return transcoder.Prefix(AssetRef{TenantID: tenantID, AssetID: assetID}) + "source/original"
}

// loadWork reads a video as the transcoder sees it, with its plan parsed.
func (d *module) loadWork(ctx context.Context, ref AssetRef) (transcoder.Work, transcoder.Plan, error) {
	w, err := d.Work(ctx, ref)
	var p transcoder.Plan
	if err == nil && len(w.Plan) > 0 {
		err = json.Unmarshal(w.Plan, &p)
	}
	return w, p, err
}

// presetOf is the library's custom preset when it has one, else its template (an unknown template, which only a
// removed one could be, falls back to the default).
func presetOf(r db.AssetPresetRow) transcoder.Preset {
	if r.Quality.Valid {
		heights := make([]int, len(r.Heights))
		for i, h := range r.Heights {
			heights[i] = int(h)
		}
		return transcoder.Preset{Heights: heights, Quality: transcoder.Quality(r.Quality.String)}
	}
	t, ok := transcoder.TemplateByKey(r.PresetTemplate)
	if !ok {
		t, _ = transcoder.TemplateByKey(transcoder.DefaultTemplate)
	}
	return t.Preset
}
