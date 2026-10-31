package webhooks

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/netip"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/webhooks/db"
)

const webhookGiveUpAfter = 24 * time.Hour

type deliverWorker struct {
	river.WorkerDefaults[DeliverArgs]
	*module
}

// NextRetry backs off from 10 s, doubling, capped at an hour.
func (w *deliverWorker) NextRetry(job *river.Job[DeliverArgs]) time.Time {
	return time.Now().Add(min(10*time.Second<<min(job.Attempt-1, 20), time.Hour))
}

var (
	failGaveUp      = core.Sentence("Your endpoint kept failing for 24 hours, so we stopped trying.")
	failSlow        = core.Sentence("Your endpoint didn't answer in time.")
	failUnreachable = core.Sentence("We couldn't reach your endpoint.")
	failRefused     = core.Sentence("Your endpoint answered with an error.")
)

// Work sends the event and records what happened on the delivery row, for the customer's history.
func (w *deliverWorker) Work(ctx context.Context, job *river.Job[DeliverArgs]) error {
	code, err := w.attempt(ctx, job)
	a := job.Args
	if !a.DeliveryID.Valid { // queued before deliveries were recorded
		return err
	}
	var cancel *river.JobCancelError
	rec := func(q tx) error {
		switch {
		case err == nil:
			return q.RecordDelivery(ctx, db.RecordDeliveryParams{ID: a.DeliveryID, Status: "done", StatusCode: pgtype.Int4{Int32: code, Valid: code > 0}})
		case errors.As(err, &cancel):
			return q.FailDelivery(ctx, db.FailDeliveryParams{ID: a.DeliveryID, Failure: pgtype.Text{String: core.PlainFailure(err), Valid: true}})
		}
		next := w.NextRetry(job)
		return q.RecordDelivery(ctx, db.RecordDeliveryParams{ID: a.DeliveryID, Status: "retrying", StatusCode: pgtype.Int4{Int32: code, Valid: code > 0},
			Failure: pgtype.Text{String: core.PlainFailure(err), Valid: true}, NextAttemptAt: pgtype.Timestamptz{Time: next, Valid: true}})
	}
	if rerr := inTenant(ctx, w.Pool, a.TenantID, rec); rerr != nil {
		slog.ErrorContext(ctx, "recording webhook delivery failed", "delivery", a.DeliveryID, "err", rerr)
	}
	return err
}

// attempt is one try; the code is the endpoint's answer, 0 when it gave none.
func (w *deliverWorker) attempt(ctx context.Context, job *river.Job[DeliverArgs]) (int32, error) {
	a := job.Args
	if time.Since(job.CreatedAt) > webhookGiveUpAfter {
		slog.Warn("webhook dropped after 24 h of failures", "endpoint", a.EndpointID)
		return 0, river.JobCancel(&core.PlainError{Sentence: failGaveUp, Cause: errors.New("gave up after 24h")})
	}
	var ep db.GetWebhookEndpointRow
	err := inTenant(ctx, w.Pool, a.TenantID, func(q tx) (err error) {
		ep, err = q.GetWebhookEndpoint(ctx, a.EndpointID)
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil // endpoint deleted since
	}
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ep.Url, bytes.NewReader(a.Body))
	if err != nil {
		return 0, river.JobCancel(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "ulka-webhooks")
	secret, err := core.Open(w.SealKey, ep.Secret)
	if err != nil {
		return 0, err // retried: a wrong SEAL_KEY is an outage to fix, not a reason to drop the event
	}
	req.Header.Set("Ulka-Signature", signWebhook(string(secret), time.Now(), a.Body))
	res, err := WebhookClient.Do(req)
	if err != nil {
		if core.PlainFailure(err) == core.FailTimeout {
			return 0, &core.PlainError{Sentence: failSlow, Cause: err}
		}
		return 0, &core.PlainError{Sentence: failUnreachable, Cause: err}
	}
	io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
	res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return int32(res.StatusCode), &core.PlainError{Sentence: failRefused, Cause: fmt.Errorf("endpoint answered %d", res.StatusCode)}
	}
	return int32(res.StatusCode), nil
}

// signWebhook is "t=<unix>,v1=<hex hmac-sha256 of "<unix>.<body>">"; receivers check it and reject old timestamps.
func signWebhook(secret string, now time.Time, body []byte) string {
	t := strconv.FormatInt(now.Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(t + "." + string(body)))
	return "t=" + t + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}

// WebhookClient refuses anything but public addresses, checked on the resolved IP at connect time so DNS cannot sneak past it.
var WebhookClient = core.PublicClient(15 * time.Second)

func publicAddr(hostport string) bool {
	ap, err := netip.ParseAddrPort(hostport)
	if err != nil {
		return false
	}
	return core.PublicIP(ap.Addr())
}

// DeliverArgs sends one event to one webhook endpoint.
type DeliverArgs struct {
	TenantID   pgtype.UUID     `json:"tenant_id"`
	EndpointID pgtype.UUID     `json:"endpoint_id"`
	Body       json.RawMessage `json:"body"`
	DeliveryID pgtype.UUID     `json:"delivery_id"` // the history row; not Valid on jobs queued before it existed
}

func (DeliverArgs) Kind() string { return "webhook" }

func (DeliverArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: "webhooks", MaxAttempts: 100} // the 24 h cutoff ends it first
}

// fanoutWorker turns one event into a delivery per endpoint, each retried on its own.
type fanoutWorker struct {
	river.WorkerDefaults[core.EventArgs]
	*module
}

func (w *fanoutWorker) Work(ctx context.Context, job *river.Job[core.EventArgs]) error {
	return inTenant(ctx, w.Pool, job.Args.TenantID, func(q tx) error {
		var ev struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(job.Args.Body, &ev); err != nil {
			return river.JobCancel(err)
		}
		ids, err := db.New(q.Tx).WebhookEndpointIDs(ctx, ev.Type) // switched on and wanting this event
		if err != nil || len(ids) == 0 {
			return err
		}
		jobs := make([]river.InsertManyParams, len(ids))
		for i, id := range ids {
			did, err := db.New(q.Tx).CreateDelivery(ctx, db.CreateDeliveryParams{EndpointID: id, Event: ev.Type, Body: job.Args.Body})
			if err != nil {
				return err
			}
			jobs[i] = river.InsertManyParams{Args: DeliverArgs{TenantID: job.Args.TenantID, EndpointID: id, Body: job.Args.Body, DeliveryID: did}}
		}
		_, err = river.ClientFromContext[pgx.Tx](ctx).InsertManyTx(ctx, q.Tx, jobs)
		return err
	})
}
