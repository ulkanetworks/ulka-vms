package core

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"
)

type Event struct {
	ID        string    `json:"id"`
	Type      string    `json:"type"`
	CreatedAt time.Time `json:"created_at"`
	Data      any       `json:"data"`
}

// Emit queues the event inside the caller's transaction, so it exists exactly when its change commits. The
// webhooks module sends it on to each of the tenant's endpoints.
func Emit(ctx context.Context, rc *river.Client[pgx.Tx], q TenantTx, typ string, data any) error {
	body, err := json.Marshal(Event{ID: "evt_" + strings.ToLower(rand.Text()), Type: typ, CreatedAt: time.Now().UTC(), Data: data})
	if err != nil {
		return err
	}
	_, err = rc.InsertTx(ctx, q.Tx, EventArgs{TenantID: q.TenantID, Body: body}, nil)
	return err
}

// EventArgs is one event for a tenant, waiting to be fanned out to its webhook endpoints.
type EventArgs struct {
	TenantID pgtype.UUID     `json:"tenant_id"`
	Body     json.RawMessage `json:"body"`
}

func (EventArgs) Kind() string { return "event" }

func (EventArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: "webhooks", MaxAttempts: 25}
}
