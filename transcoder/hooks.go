package transcoder

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ulkanetworks/ulka-vms/core"
)

// AssetRef names the work: the workspace, the video it is for, and the job reporting on it. The transcoder only
// carries it back to Hooks. Its JSON names are what queued jobs already hold.
type AssetRef struct {
	TenantID pgtype.UUID `json:"tenant_id"`
	AssetID  pgtype.UUID `json:"asset_id"`
	JobID    pgtype.UUID `json:"job_id"`
}

// Prefix is where everything about one video is stored: <workspace>/<video>/. Files of the transcoder (renditions,
// the chunks it works from under work/) and of the video module (source, captions, images) share it, so deleting a
// video deletes the prefix.
func Prefix(ref AssetRef) string { return ref.TenantID.String() + "/" + ref.AssetID.String() + "/" }

// Work is what the transcoder needs to know about a video.
type Work struct {
	SourceKey       string
	DurationSeconds float64
	Plan            []byte // JSON written by Planned; empty before the video is planned
	Key, IV         []byte // the encryption key, unsealed, once planned
	Preset          Preset // which rungs to make and how carefully
}

// Planned is the transcoder's reading of a source and the ladder it chose, for the owner to store.
type Planned struct {
	Probe         []byte
	Duration      float64
	Width, Height int
	Plan          []byte
	Key, IV       []byte // a fresh key for this video, unsealed: the owner seals it
}

// Hooks is everything the transcoder asks of whoever owns the videos, and every report it makes. The transcoder
// holds no video record of its own; this keeps the two modules apart. Methods that take a TenantTx run inside the
// transcoder's transaction.
type Hooks interface {
	// Work reads a video; pgx.ErrNoRows when it no longer exists.
	Work(ctx context.Context, ref AssetRef) (Work, error)
	// Started says the first attempt at a video began.
	Started(ctx context.Context, ref AssetRef) error
	// Admit decides whether a video of this length may be encoded (a workspace's allowance); a non-empty code
	// refuses it.
	Admit(ctx context.Context, tx core.TenantTx, ref AssetRef, durationSeconds float64) (code string, err error)
	// Planned stores what the transcoder learned, in the same transaction that queues the pieces.
	Planned(ctx context.Context, tx core.TenantTx, ref AssetRef, p Planned) error
	// Publish runs upload (which puts the master playlist in place), then marks the video playable at stage
	// "ready" (its fast qualities) or finished at "complete". It does nothing if the video has moved on.
	Publish(ctx context.Context, ref AssetRef, stage string, upload func(ctx context.Context) error) error
	// Failed says the video cannot be encoded; code is a stable reason.
	Failed(ctx context.Context, ref AssetRef, code string) error
}
