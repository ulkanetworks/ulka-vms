package transcoder

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/transcoder/db"
)

// Start queues a video's source to be read and encoded, in tx's transaction.
func Start(ctx context.Context, rc *river.Client[pgx.Tx], q core.TenantTx, ref AssetRef) error {
	_, err := rc.InsertTx(ctx, q.Tx, ProbeArgs{AssetRef: ref}, nil)
	return err
}

// Restart forgets the video's earlier pieces and queues its source to be read and encoded again.
func Restart(ctx context.Context, rc *river.Client[pgx.Tx], q core.TenantTx, ref AssetRef) error {
	if err := db.New(q.Tx).DeleteEncodeTasks(ctx, ref.AssetID); err != nil {
		return err
	}
	return Start(ctx, rc, q, ref)
}

// Progress is how many pieces of a lane are done.
type Progress struct {
	AssetID     pgtype.UUID
	Lane        string
	Done, Total int32
	Partial     float64 // how far the pieces being encoded now have got, in pieces (0.5 is half of one)
}

// Progress counts the pieces done and in all, per video and lane.
func ProgressOf(ctx context.Context, q core.TenantTx, assets []pgtype.UUID) ([]Progress, error) {
	rows, err := db.New(q.Tx).TaskProgress(ctx, assets)
	out := make([]Progress, len(rows))
	for i, r := range rows {
		out[i] = Progress{r.AssetID, r.Lane, r.Done, r.Total, r.Partial}
	}
	return out, err
}

// TaskInfo is one piece of a video's encode as the scheduler sees it.
type TaskInfo struct {
	Lane     string
	Chunk    int32
	Done     bool
	State    string // done, running, retrying, queued or failed
	Node     string // the machine running it, or that last ran it
	Attempts int32
	Progress float32 // of the try running now, 0 to 1
	Error    string  // the last try's failure
	// Queued, last started and finished (zero when it hasn't).
	Queued, Started, Finished time.Time
}

func Tasks(ctx context.Context, q core.TenantTx, asset pgtype.UUID) ([]TaskInfo, error) {
	rows, err := db.New(q.Tx).ListEncodeTasks(ctx, asset)
	out := make([]TaskInfo, len(rows))
	for i, r := range rows {
		out[i] = TaskInfo{r.Lane, r.Chunk, r.Done, r.State, r.Node, r.Attempts, r.Progress, r.LastError, r.CreatedAt.Time, r.StartedAt.Time, r.DoneAt.Time}
	}
	return out, err
}
