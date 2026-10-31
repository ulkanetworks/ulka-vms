// Package usage reports what a tenant consumed per calendar month (UTC). It shows quantities; prices come later.
package usage

import (
	"context"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/core/db"
	"github.com/ulkanetworks/ulka-vms/video"
)

// Units is each meter's unit. An application built on ulka-vms adds its own meters at start.
var Units = map[string]string{
	"video_minutes_encoded":   "minutes",
	"video_minutes_stored":    "minutes",
	"video_delivery_bytes":    "bytes",
	"video_delivery_requests": "requests",
}

// Used counts what a workspace has of something its limits cap, by the name /v1/limits shows it under. An
// application built on ulka-vms adds its own at start.
var Used = map[string]func(ctx context.Context, q core.TenantTx) (float64, error){
	// this month, including videos still encoding
	"encode_minutes": func(ctx context.Context, q core.TenantTx) (float64, error) {
		return video.MinutesCommitted(ctx, q, pgtype.UUID{})
	},
}

type module struct{ *core.Deps }

func Routes(mux *http.ServeMux, d *core.Deps) {
	m := &module{d}
	mux.HandleFunc("GET /v1/usage", m.Auth(core.Anyone, m.get))
	mux.HandleFunc("GET /v1/limits", m.Auth(core.Anyone, m.limits))
}

func (m *module) get(w http.ResponseWriter, r *http.Request, p core.Principal) {
	now := time.Now().UTC()
	start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	if s := r.URL.Query().Get("month"); s != "" {
		t, err := time.Parse("2006-01", s)
		if err != nil {
			core.WriteError(w, http.StatusBadRequest, "invalid_month")
			return
		}
		start = t
	}
	end := start.AddDate(0, 1, 0)
	var out struct {
		Period struct {
			Start time.Time `json:"start"`
			End   time.Time `json:"end"`
		} `json:"period"`
		Units    map[string]string     `json:"units"`
		Totals   []db.UsageTotalsRow   `json:"totals"`
		Daily    []db.UsageDailyRow    `json:"daily"`
		ByRegion []db.UsageByRegionRow `json:"by_region"`
	}
	out.Period.Start, out.Period.End, out.Units = start, end, Units
	// Lists are empty, never null, like every other list in the API.
	out.Totals, out.Daily, out.ByRegion = []db.UsageTotalsRow{}, []db.UsageDailyRow{}, []db.UsageByRegionRow{}
	err := core.InTenant(r.Context(), m.Pool, p.TenantID, func(q core.TenantTx) error {
		since, until := ts(start), ts(end)
		totals, err := q.UsageTotals(r.Context(), db.UsageTotalsParams{Since: since, Until: until})
		if err != nil {
			return err
		}
		daily, err := q.UsageDaily(r.Context(), db.UsageDailyParams{Since: since, Until: until})
		if err != nil {
			return err
		}
		regions, err := q.UsageByRegion(r.Context(), db.UsageByRegionParams{Since: since, Until: until})
		out.Totals, out.Daily, out.ByRegion = append(out.Totals, totals...), append(out.Daily, daily...), append(out.ByRegion, regions...)
		return err
	})
	if err != nil {
		core.InternalError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, out)
}

func ts(t time.Time) pgtype.Timestamptz { return pgtype.Timestamptz{Time: t, Valid: true} }

// limits shows the workspace's limits beside what it has used of each, so nothing comes as a surprise.
func (m *module) limits(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var out struct {
		Limits map[string]any     `json:"limits"`
		Used   map[string]float64 `json:"used"`
	}
	out.Limits, out.Used = map[string]any{}, map[string]float64{}
	err := core.InTenant(r.Context(), m.Pool, p.TenantID, func(q core.TenantTx) error {
		if err := core.ReadAllLimits(r.Context(), q, &out.Limits); err != nil {
			return err
		}
		for name, count := range Used {
			n, err := count(r.Context(), q)
			if err != nil {
				return err
			}
			out.Used[name] = n
		}
		return nil
	})
	if err != nil {
		core.InternalError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, out)
}
