package video

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/video/db"
)

// What other modules may use from video: they never touch its tables.

// DeleteVideo deletes a video for good, as DELETE /v1/assets/{id} does: asset.deleted is sent and its files go.
func DeleteVideo(ctx context.Context, t core.TenantTx, rc *river.Client[pgx.Tx], id pgtype.UUID) error {
	return purge(ctx, rc, with(t), id)
}

// MinutesCommitted is this month's encoded minutes plus videos accepted but not finished (except exclude), which
// will count when they do.
func MinutesCommitted(ctx context.Context, t core.TenantTx, exclude pgtype.UUID) (float64, error) {
	done, err := t.EncodedMinutesThisMonth(ctx)
	if err != nil {
		return 0, err
	}
	pending, err := with(t).PendingEncodeMinutes(ctx, exclude)
	return done + pending, err
}

// StoredMinutes is every tenant's playable minutes, for the storage meter (across tenants, by a narrow function).
func StoredMinutes(ctx context.Context, pool *pgxpool.Pool) ([]db.StoredMinutesRow, error) {
	return db.New(pool).StoredMinutes(ctx)
}

// Notices are videos that failed this week and the encoding limit nearing, for those who can read videos.
func Notices(ctx context.Context, t core.TenantTx, p core.Principal, now time.Time) ([]core.Notice, error) {
	if !p.Can("video:read") {
		return nil, nil
	}
	var out []core.Notice
	v, err := with(t).NoticeFailedVideos(ctx)
	if err != nil {
		return nil, err
	}
	if v.N > 0 {
		out = append(out, core.Notice{ID: "videos_failed", Kind: "videos_failed", Severity: "warning", At: v.Latest.Time, Data: map[string]any{"count": v.N}})
	}
	limits, err := core.LimitsFor(ctx, t)
	if err != nil {
		return nil, err
	}
	used, err := MinutesCommitted(ctx, t, pgtype.UUID{})
	if err != nil {
		return nil, err
	}
	if of := float64(limits.EncodeMinutesMonthly); of > 0 && used >= 0.8*of {
		sev := "warning"
		if used >= of {
			sev = "danger"
		}
		out = append(out, core.Notice{ID: "limit_encode_minutes", Kind: "limit_encode_minutes", Severity: sev, At: now,
			Data: map[string]any{"used": used, "limit": of}})
	}
	return out, nil
}

// Technical is one video's technical view (source, plan, encoding, pipeline, storage) read inside its tenant, for
// Ulka admin. It carries no keys and no content links.
func Technical(ctx context.Context, d *core.Deps, tenant, asset pgtype.UUID) (any, error) {
	return technicalOf(ctx, d, tenant, asset, func(fn func(tx) error) error { return inTenant(ctx, d.Pool, tenant, fn) })
}

// PlaybackCheck plays one video as a player on another website would, read inside its tenant, for Ulka admin.
func PlaybackCheck(ctx context.Context, d *core.Deps, tenant, asset pgtype.UUID) (map[string]any, error) {
	return (&module{Deps: d}).checkPlayback(ctx, "", func(fn func(tx, pgtype.UUID) error) error {
		return inTenant(ctx, d.Pool, tenant, func(q tx) error { return fn(q, asset) })
	})
}

// LibraryPlayer is the player settings document a library stores (empty when it never set one); pgx.ErrNoRows when
// the library doesn't exist. The player module owns what the document means.
func LibraryPlayer(ctx context.Context, t core.TenantTx, id pgtype.UUID) ([]byte, error) {
	rows, err := with(t).ListLibraries(ctx, id)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, pgx.ErrNoRows
	}
	return rows[0].Player, nil
}

// SetLibraryPlayer stores a library's player settings document; pgx.ErrNoRows when the library doesn't exist.
func SetLibraryPlayer(ctx context.Context, t core.TenantTx, id pgtype.UUID, doc []byte) error {
	n, err := with(t).SetLibraryPlayer(ctx, db.SetLibraryPlayerParams{ID: id, Player: doc})
	if err == nil && n == 0 {
		return pgx.ErrNoRows
	}
	return err
}

// Viewing is what the player's config needs about a video a viewer may watch.
type Viewing struct {
	Title, Status, Policy string
	DurationSeconds       float64
	Watermark             string // from the viewer's verified signature
	Access                Access // which websites may embed it (countries are already checked)
	Player                []byte // the library's player settings document
	Chapters              []Chapter
	Link                  func(file string) string // a file beside the video, with the viewer's signature when there is one
	Poster                string                   // the thumbnail's address, versioned by the choice so a new one shows at once
}

// viewing loads what the player's config shows about p; an error means the video went away meanwhile.
func (s *module) viewing(r *http.Request, p playback) (Viewing, error) {
	out := Viewing{Link: p.link, Policy: p.policy, Status: p.status, DurationSeconds: p.duration, Watermark: p.watermark, Chapters: []Chapter{}}
	err := inTenant(r.Context(), s.Pool, p.tenantID, func(q tx) error {
		a, err := q.GetAsset(r.Context(), p.assetID)
		if err != nil {
			return err
		}
		lib, err := q.PlayerLibrary(r.Context(), p.assetID)
		if err != nil {
			return err
		}
		out.Title = a.Title
		out.Poster = p.link("poster.jpg?v=" + posterVersion(a))
		if err := json.Unmarshal(a.Chapters, &out.Chapters); err != nil {
			return err
		}
		out.Access, out.Player = Access{lib.AllowedDomains, lib.BlockedDomains, lib.CountryMode, lib.Countries}, lib.Player
		return nil
	})
	return out, err
}
