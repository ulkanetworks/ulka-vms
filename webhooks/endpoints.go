package webhooks

import (
	"cmp"
	"crypto/rand"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/webhooks/db"
)

// CheckHost refuses addresses deliveries could never reach. Tests replace it with WebhookClient, for local receivers.
var CheckHost = core.CheckPublicHost

var (
	errInvalidURL    = core.APIError{Status: http.StatusBadRequest, Code: "invalid_url"}
	errURLNotPublic  = core.APIError{Status: http.StatusBadRequest, Code: "url_not_public"}
	errInvalidEvents = core.APIError{Status: http.StatusBadRequest, Code: "invalid_events"}
	errInvalidName   = core.APIError{Status: http.StatusBadRequest, Code: "invalid_name"}
)

// checkURL is an endpoint address deliveries can reach: https, a public host, no user or fragment.
func checkURL(r *http.Request, raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" || len(raw) > core.MaxURL {
		return errInvalidURL
	}
	// Deliveries never go to private addresses, so one saved here would fail silently for a day; refuse it now.
	if err := CheckHost(r.Context(), u.Hostname()); errors.Is(err, core.ErrOriginPrivate) {
		return errURLNotPublic
	} else if err != nil {
		return errInvalidURL
	}
	return nil
}

// checkChoices validates an endpoint's name and chosen events (none = every event), returning the events deduplicated.
func checkChoices(name string, events []string) ([]string, error) {
	if utf8.RuneCountInString(name) > core.MaxName {
		return nil, errInvalidName
	}
	out := []string{}
	for _, e := range events {
		if !core.IsWebhookEvent(e) {
			return nil, errInvalidEvents
		}
		if !slices.Contains(out, e) {
			out = append(out, e)
		}
	}
	return out, nil
}

func (s *module) createWebhookEndpoint(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var in struct {
		Name   string   `json:"name"`
		URL    string   `json:"url"`
		Events []string `json:"events"` // empty for every event
	}
	if !core.Decode(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	events, err := checkChoices(in.Name, in.Events)
	if err == nil {
		err = checkURL(r, in.URL)
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	secret := "whsec_" + rand.Text()
	sealed, err := core.Seal(s.SealKey, []byte(secret))
	if err != nil {
		core.InternalError(w, r, err)
		return
	}
	var row db.CreateWebhookEndpointRow
	err = inTenant(r.Context(), s.Pool, p.TenantID, func(q tx) (err error) {
		row, err = q.CreateWebhookEndpoint(r.Context(), db.CreateWebhookEndpointParams{Name: in.Name, Url: in.URL, Secret: sealed, Events: events})
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusCreated, map[string]any{"id": row.ID, "name": row.Name, "url": row.Url, "events": row.Events,
		"enabled": row.Enabled, "created_at": row.CreatedAt, "secret": secret})
}

// updateWebhookEndpoint renames an endpoint, moves it, changes its events or switches it on or off; only what's given.
func (s *module) updateWebhookEndpoint(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var in struct {
		Name    *string   `json:"name"`
		URL     *string   `json:"url"`
		Events  *[]string `json:"events"`
		Enabled *bool     `json:"enabled"`
	}
	if !core.Decode(w, r, &in) {
		return
	}
	params := db.UpdateWebhookEndpointParams{}
	var err error
	if in.Name != nil {
		params.Name = pgtype.Text{String: strings.TrimSpace(*in.Name), Valid: true}
		_, err = checkChoices(params.Name.String, nil)
	}
	if err == nil && in.Events != nil {
		params.Events, err = checkChoices("", *in.Events)
	}
	if err == nil && in.URL != nil {
		params.Url, err = pgtype.Text{String: *in.URL, Valid: true}, checkURL(r, *in.URL)
	}
	if in.Enabled != nil {
		params.Enabled = pgtype.Bool{Bool: *in.Enabled, Valid: true}
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	var row db.UpdateWebhookEndpointRow
	err = withPathID(s.Deps, r, p, func(q tx, id pgtype.UUID) (err error) {
		params.ID = id
		row, err = q.UpdateWebhookEndpoint(r.Context(), params)
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, row)
}

func (s *module) showWebhookEndpoint(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var row db.ShowWebhookEndpointRow
	err := withPathID(s.Deps, r, p, func(q tx, id pgtype.UUID) (err error) {
		row, err = q.ShowWebhookEndpoint(r.Context(), id)
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, row)
}

func (s *module) listWebhookEndpoints(w http.ResponseWriter, r *http.Request, p core.Principal) {
	c, err := core.ParseCursor(r)
	var after pgtype.UUID
	if err == nil {
		after, err = c.AfterUUID()
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	var endpoints []db.ListWebhookEndpointsRow
	var total int64
	err = inTenant(r.Context(), s.Pool, p.TenantID, func(q tx) (err error) {
		endpoints, err = q.ListWebhookEndpoints(r.Context(), db.ListWebhookEndpointsParams{Pattern: c.Like(), AfterAt: c.At, AfterID: after, Lim: c.Fetch()})
		if err != nil {
			return err
		}
		total, err = q.CountWebhookEndpoints(r.Context(), c.Like())
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, core.PagedTotal(endpoints, c, func(e db.ListWebhookEndpointsRow) (time.Time, string) {
		return e.CreatedAt.Time, e.ID.String()
	}, total))
}

func (s *module) deleteWebhookEndpoint(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var n int64
	err := withPathID(s.Deps, r, p, func(q tx, id pgtype.UUID) (err error) {
		n, err = q.DeleteWebhookEndpoint(r.Context(), id)
		return err
	})
	switch {
	case err != nil:
		core.RespondError(w, r, err)
	case n == 0:
		core.WriteError(w, http.StatusNotFound, "not_found")
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

var errNotFailed = core.APIError{Status: http.StatusConflict, Code: "delivery_not_failed"}

// listDeliveries is an endpoint's recent deliveries, newest first. Failures are plain sentences, never the remote's words.
func (s *module) listDeliveries(w http.ResponseWriter, r *http.Request, p core.Principal) {
	c, err := core.ParseCursor(r)
	var after pgtype.UUID
	if err == nil {
		after, err = c.AfterUUID()
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	out := []db.ListDeliveriesPageRow{}
	var total int64
	err = withPathID(s.Deps, r, p, func(q tx, id pgtype.UUID) error {
		if ok, err := q.EndpointExists(r.Context(), id); err != nil || !ok {
			return cmp.Or(err, pgx.ErrNoRows)
		}
		var err error
		if total, err = q.CountDeliveries(r.Context(), id); err != nil {
			return err
		}
		rows, err := q.ListDeliveriesPage(r.Context(), db.ListDeliveriesPageParams{EndpointID: id, AfterAt: c.At, AfterID: after, Lim: c.Fetch()})
		out = append(out, rows...)
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, core.PagedTotal(out, c, func(v db.ListDeliveriesPageRow) (time.Time, string) { return v.CreatedAt.Time, v.ID.String() }, total))
}

// retryDelivery sends a failed delivery again. One already waiting to be sent answers the same, so a double click is harmless.
func (s *module) retryDelivery(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var did pgtype.UUID
	if did.Scan(r.PathValue("deliveryId")) != nil {
		core.WriteError(w, http.StatusNotFound, "not_found")
		return
	}
	err := withPathID(s.Deps, r, p, func(q tx, id pgtype.UUID) error {
		row, err := q.RequeueDelivery(r.Context(), db.RequeueDeliveryParams{ID: did, EndpointID: id})
		if errors.Is(err, pgx.ErrNoRows) {
			st, serr := q.GetDeliveryStatus(r.Context(), db.GetDeliveryStatusParams{ID: did, EndpointID: id})
			if serr == nil && (st == "pending" || st == "retrying") {
				return nil
			} else if serr == nil {
				return errNotFailed
			}
			return serr
		}
		if err != nil {
			return err
		}
		_, err = s.River.InsertTx(r.Context(), q.Tx, DeliverArgs{TenantID: q.TenantID, EndpointID: id, Body: row.Body, DeliveryID: row.ID}, nil)
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusAccepted, map[string]any{"id": did, "status": "pending"})
}
