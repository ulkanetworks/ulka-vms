package transcoder

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/ulkanetworks/ulka-vms/core"
)

// The scheduler decides which node encodes which piece of which video. The control plane (probe) only records the
// pieces as encode_tasks; a node asks for work it has room for (scheduler_claim, migration 0067) and is given the
// fairest next pieces; it keeps its claims alive while it works; a claim nobody renews lapses and the piece goes to
// another node. Nodes dial out to the database like any worker, so none listens on a port.
const (
	leaseFor        = time.Minute
	renewEvery      = 20 * time.Second
	pollEvery       = time.Second
	retryAfter      = 10 * time.Second
	maxTaskAttempts = 6
)

type claimed struct {
	ref      AssetRef
	lane     string
	chunk    int
	attempts int
}

// claim takes up to free waiting tasks for node.
func (d *module) claim(ctx context.Context, node string, free int) ([]claimed, error) {
	rows, err := d.Pool.Query(ctx, `SELECT tenant_id, asset_id, job_id, lane, chunk, attempts FROM scheduler_claim($1, $2, $3, $4, $5)`,
		node, free, tenantEncodeSlots, leaseFor, maxTaskAttempts)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []claimed
	for rows.Next() {
		var c claimed
		if err := rows.Scan(&c.ref.TenantID, &c.ref.AssetID, &c.ref.JobID, &c.lane, &c.chunk, &c.attempts); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// RunEncoder is a node's side: until ctx ends it keeps up to slots tasks running, claiming more as each finishes.
// It returns once the ones already running are done; they are not cut off by ctx.
func RunEncoder(ctx context.Context, d *core.Deps, hooks Hooks, node string, slots int, encoders []string) {
	m := &module{Deps: d, hooks: hooks}
	if !slices.Contains(encoders, "h264") {
		slog.Warn("this machine can't encode H.264, so it takes no video work", "node", node)
		<-ctx.Done()
		return
	}
	var running atomic.Int32
	var wg sync.WaitGroup
	nudge := make(chan struct{}, 1)
	poll, renew := time.NewTicker(pollEvery), time.NewTicker(renewEvery)
	defer poll.Stop()
	defer renew.Stop()
	for {
		select {
		case <-ctx.Done():
			wg.Wait()
			return
		case <-renew.C:
			if _, err := m.Pool.Exec(ctx, `SELECT scheduler_renew($1, $2)`, node, leaseFor); err != nil && ctx.Err() == nil {
				slog.Warn("could not renew encode leases", "err", err)
			}
		case <-poll.C:
		case <-nudge:
		}
		free := slots - int(running.Load())
		if free <= 0 || ctx.Err() != nil {
			continue
		}
		tasks, err := m.claim(ctx, node, free)
		if err != nil {
			if ctx.Err() == nil {
				slog.Warn("could not ask the scheduler for work", "err", err)
			}
			continue
		}
		for _, t := range tasks {
			running.Add(1)
			wg.Add(1)
			go func() {
				defer func() {
					running.Add(-1)
					wg.Done()
					select {
					case nudge <- struct{}{}:
					default:
					}
				}()
				// Shutdown stops claiming but lets a started encode finish; the job timeout still bounds it.
				tctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), core.JobTimeout)
				defer cancel()
				m.runTask(tctx, node, t)
			}()
		}
	}
}

// runTask does one claimed piece. A failure goes back to the scheduler, which offers it again after a pause until
// its tries run out.
func (d *module) runTask(ctx context.Context, node string, t claimed) {
	var err error
	if t.lane == "audio" {
		err = d.encodeAudio(ctx, t.ref)
	} else {
		err = d.encodeChunk(ctx, t.ref, t.lane, t.chunk, func(share float64) {
			if _, err := d.Pool.Exec(ctx, `SELECT scheduler_progress($1, $2, $3, $4, $5)`, t.ref.AssetID, t.lane, t.chunk, node, share); err != nil && ctx.Err() == nil {
				slog.Warn("could not record encode progress", "asset", t.ref.AssetID, "err", err) // only the bar lags
			}
		})
	}
	if err == nil {
		return
	}
	if errors.Is(err, pgx.ErrNoRows) { // the video was deleted while we worked
		slog.Info("encode task dropped: video is gone", "asset", t.ref.AssetID, "lane", t.lane, "chunk", t.chunk)
		return
	}
	slog.ErrorContext(ctx, "encode task failed", "asset", t.ref.AssetID, "lane", t.lane, "chunk", t.chunk, "attempt", t.attempts, "err", err)
	if _, err := d.Pool.Exec(context.WithoutCancel(ctx), `SELECT scheduler_release($1, $2, $3, $4, $5, $6)`,
		t.ref.AssetID, t.lane, t.chunk, node, core.PlainFailure(err), retryAfter); err != nil {
		slog.Error("could not give an encode task back", "asset", t.ref.AssetID, "err", err)
	}
}

type sweepWorker struct {
	river.WorkerDefaults[SweepArgs]
	*module
}

// Work fails every video that has a task out of tries, whether it failed or its nodes kept dying. A video already
// playable keeps playing: fail only errors one that isn't.
func (w *sweepWorker) Work(ctx context.Context, _ *river.Job[SweepArgs]) error {
	rows, err := w.Pool.Query(ctx, `SELECT tenant_id, asset_id, job_id FROM scheduler_exhausted($1)`, maxTaskAttempts)
	if err != nil {
		return err
	}
	var refs []AssetRef
	for rows.Next() {
		var r AssetRef
		if err := rows.Scan(&r.TenantID, &r.AssetID, &r.JobID); err != nil {
			rows.Close()
			return err
		}
		refs = append(refs, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	var errs []error
	for _, r := range refs {
		slog.Error("video gave up: an encode task ran out of tries", "asset", r.AssetID)
		if err := w.fail(ctx, r, "encode_failed"); err != nil {
			errs = append(errs, err)
			continue
		}
		_, err := w.Pool.Exec(ctx, `SELECT scheduler_written_off($1, $2)`, r.AssetID, maxTaskAttempts)
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}
