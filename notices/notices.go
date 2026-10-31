// Package notices tells a workspace what needs its attention, worked out from its current state each time it's asked:
// nothing is stored, so a notice goes away when its cause is fixed. Each module reports its own; this collects them.
package notices

import (
	"cmp"
	"context"
	"net/http"
	"slices"
	"time"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/video"
)

type module struct{ *core.Deps }

// Source reports one module's notices for the caller, checking the caller's permission itself.
type Source func(ctx context.Context, q core.TenantTx, p core.Principal, now time.Time) ([]core.Notice, error)

// Sources are the modules' notices. An application built on ulka-vms adds its own at start.
var Sources = []Source{video.Notices, keyNotices, func(ctx context.Context, q core.TenantTx, p core.Principal, _ time.Time) ([]core.Notice, error) {
	return supportNotices(ctx, q, p)
}}

func Routes(mux *http.ServeMux, d *core.Deps) {
	mux.HandleFunc("GET /v1/notices", d.Auth(core.Anyone, (&module{d}).list))
}

func (m *module) list(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var out []core.Notice
	err := core.InTenant(r.Context(), m.Pool, p.TenantID, func(q core.TenantTx) (err error) {
		out, err = m.collect(r.Context(), q, p, time.Now())
		return err
	})
	if err != nil {
		core.InternalError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, map[string]any{"data": out})
}

// collect gathers the notices the caller may see (each module checks the caller's permission), most serious first.
func (m *module) collect(ctx context.Context, q core.TenantTx, p core.Principal, now time.Time) ([]core.Notice, error) {
	out := []core.Notice{}
	for _, from := range Sources {
		n, err := from(ctx, q, p, now)
		if err != nil {
			return nil, err
		}
		out = append(out, n...)
	}
	rank := map[string]int{"danger": 0, "warning": 1, "info": 2}
	slices.SortStableFunc(out, func(a, b core.Notice) int {
		return cmp.Or(cmp.Compare(rank[a.Severity], rank[b.Severity]), a.At.Compare(b.At))
	})
	return out, nil
}

// keyNotices are API keys expiring within a week or already expired, for those who manage keys.
func keyNotices(ctx context.Context, q core.TenantTx, p core.Principal, now time.Time) ([]core.Notice, error) {
	if !p.Can("keys:write") {
		return nil, nil
	}
	keys, err := q.NoticeExpiringKeys(ctx)
	var out []core.Notice
	for _, k := range keys {
		kind, sev := "key_expiring", "warning"
		if k.ExpiresAt.Time.Before(now) {
			kind, sev = "key_expired", "info" // it already stopped working; revoking just tidies the list
		}
		out = append(out, core.Notice{ID: kind + ":" + k.ID.String(), Kind: kind, Severity: sev, Subject: k.ID.String(), Name: k.Name, At: k.ExpiresAt.Time})
	}
	return out, err
}

// supportNotices tell everyone in the workspace when Ulka support used the console as one of its people in the last
// 7 days, who, and why: nothing Ulka does inside a workspace is hidden from it.
func supportNotices(ctx context.Context, q core.TenantTx, p core.Principal) ([]core.Notice, error) {
	if !p.UserID.Valid {
		return nil, nil
	}
	visits, err := q.RecentSupportVisits(ctx)
	var out []core.Notice
	for _, v := range visits {
		out = append(out, core.Notice{ID: "support_visit:" + v.ID.String(), Kind: "support_visit", Severity: "info", Subject: v.ID.String(),
			Name: v.AdminName, At: v.StartedAt.Time, Data: map[string]any{"person": cmp.Or(v.UserName, v.Email), "reason": v.Reason,
				"until": v.ExpiresAt.Time}})
	}
	return out, err
}
