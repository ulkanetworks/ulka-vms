package usage

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/video"
)

// meterLookback is how far back each run recomputes: log lines arrive late, and a recomputed hour replaces its rows.
const meterLookback = 3 * time.Hour

// LogMeterArgs copies video delivered from the origin, counted from its access logs in ClickHouse, into each tenant's
// usage records.
type LogMeterArgs struct{}

func (LogMeterArgs) Kind() string { return "log_meter" }
func (LogMeterArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: "maintenance", MaxAttempts: 3}
}

type meterWorker struct {
	river.WorkerDefaults[LogMeterArgs]
	*core.Deps
	clickhouseURL string
}

// reading is one usage record to write: meter, key (unique per hour and thing), hour and quantity.
type reading struct {
	meter, key string
	hour       time.Time
	quantity   uint64
}

func (w *meterWorker) Work(ctx context.Context, _ *river.Job[LogMeterArgs]) error {
	since := map[string]string{"since": strconv.FormatInt(time.Now().Add(-meterLookback).Truncate(time.Hour).Unix(), 10)}
	byTenant := map[string][]reading{}

	var video struct {
		Hour     int64  `json:"hour"`
		TenantID string `json:"tenant_id"`
		Requests uint64 `json:"requests"`
		Bytes    uint64 `json:"egress_bytes"`
	}
	err := core.ClickHouseQuery(ctx, w.clickhouseURL, `SELECT toUnixTimestamp(hour) AS hour, tenant_id,
			sum(requests) AS requests, sum(egress_bytes) AS egress_bytes
		FROM video_delivery_hourly WHERE hour >= toDateTime({since:UInt32}) GROUP BY hour, tenant_id FORMAT JSONEachRow`, since,
		func(line []byte) error {
			if err := json.Unmarshal(line, &video); err != nil {
				return err
			}
			// Keys are unique across tenants (usage_records' primary key), so they carry the tenant.
			h, key := time.Unix(video.Hour, 0), "origin|"+video.TenantID+"|"+strconv.FormatInt(video.Hour, 10)
			byTenant[video.TenantID] = append(byTenant[video.TenantID],
				reading{"video_delivery_bytes", key, h, video.Bytes}, reading{"video_delivery_requests", key, h, video.Requests})
			return nil
		})
	if err != nil {
		return err
	}

	for tenant, rs := range byTenant {
		var id pgtype.UUID
		if id.Scan(tenant) != nil {
			slog.Warn("metered traffic for a path that names no tenant", "tenant", tenant)
			continue
		}
		err := core.InTenant(ctx, w.Pool, id, func(q core.TenantTx) error {
			// Traffic for a tenant that no longer exists (or never did: anyone can request a made-up path) is dropped.
			if _, err := q.GetTenant(ctx); err != nil {
				return err
			}
			for _, r := range rs {
				if err := core.RecordUsage(ctx, q, r.meter, r.key, r.hour, "", strconv.FormatUint(r.quantity, 10)); err != nil {
					return err
				}
			}
			return nil
		})
		if errors.Is(err, pgx.ErrNoRows) {
			slog.Warn("metered traffic for an unknown tenant", "tenant", tenant)
			continue
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// Workers registers the log meter; clickhouseURL is where the rollups are.
func Workers(w *river.Workers, d *core.Deps, clickhouseURL string) {
	river.AddWorker(w, &meterWorker{Deps: d, clickhouseURL: clickhouseURL})
	river.AddWorker(w, &storageWorker{Deps: d})
}

func PeriodicJobs() []*river.PeriodicJob {
	// Every 15 minutes: both recompute rather than add, so extra runs are harmless and no hour is skipped.
	every := func(args river.JobArgs) *river.PeriodicJob {
		return river.NewPeriodicJob(river.PeriodicInterval(15*time.Minute),
			func() (river.JobArgs, *river.InsertOpts) { return args, nil }, &river.PeriodicJobOpts{RunOnStart: true})
	}
	return []*river.PeriodicJob{every(LogMeterArgs{}), every(StorageMeterArgs{})}
}

// StorageMeterArgs records each tenant's stored video minutes for the current hour. Each hour's record is
// minutes ÷ hours in the month, so a month's total is the average minutes stored across it.
// ponytail: an hour no run lands in isn't billed; deleted videos leave no history to recompute it from.
type StorageMeterArgs struct{}

func (StorageMeterArgs) Kind() string { return "storage_meter" }
func (StorageMeterArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: "maintenance", MaxAttempts: 3}
}

type storageWorker struct {
	river.WorkerDefaults[StorageMeterArgs]
	*core.Deps
}

func (w *storageWorker) Work(ctx context.Context, _ *river.Job[StorageMeterArgs]) error {
	hour := time.Now().UTC().Truncate(time.Hour)
	month := time.Date(hour.Year(), hour.Month(), 1, 0, 0, 0, 0, time.UTC)
	hours := month.AddDate(0, 1, 0).Sub(month).Hours()
	rows, err := video.StoredMinutes(ctx, w.Pool)
	if err != nil {
		return err
	}
	for _, r := range rows {
		err := core.InTenant(ctx, w.Pool, r.TenantID, func(q core.TenantTx) error {
			key := r.TenantID.String() + "|" + strconv.FormatInt(hour.Unix(), 10)
			return core.RecordUsage(ctx, q, "video_minutes_stored", key, hour, "", strconv.FormatFloat(r.Minutes/hours, 'f', 6, 64))
		})
		if err != nil {
			return err
		}
	}
	return nil
}
