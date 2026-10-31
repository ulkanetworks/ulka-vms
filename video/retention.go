package video

import (
	"context"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"

	"github.com/ulkanetworks/ulka-vms/core"
)

// trashDays is how long a video stays in the trash before it is deleted for good.
const trashDays = 30

// A chunk job already running when its asset is deleted can still write for up to core.JobTimeout; the second pass catches that.
const lateDeleteAfter = 5 * time.Hour

// purge deletes a video for good: its record, playback ids and (in the background) every stored file.
func purge(ctx context.Context, rc *river.Client[pgx.Tx], q tx, id pgtype.UUID) error {
	view, err := LoadAssetView(ctx, q, id)
	if err != nil {
		return err
	}
	if err := core.Emit(ctx, rc, q.TenantTx, "asset.deleted", view); err != nil {
		return err
	}
	if _, err := q.DeleteAsset(ctx, id); err != nil {
		return err
	}
	prefix := q.TenantID.String() + "/" + id.String() + "/"
	_, err = rc.InsertManyTx(ctx, q.Tx, []river.InsertManyParams{
		{Args: DeletePrefixArgs{Prefix: prefix}},
		{Args: DeletePrefixArgs{Prefix: prefix}, InsertOpts: &river.InsertOpts{ScheduledAt: time.Now().Add(lateDeleteAfter)}},
	})
	return err
}

func (s *module) deleteAsset(w http.ResponseWriter, r *http.Request, p core.Principal) {
	err := withPathID(s.Deps, r, p, func(q tx, id pgtype.UUID) error { return purge(r.Context(), s.River, q, id) })
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
