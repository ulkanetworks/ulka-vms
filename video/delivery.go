package video

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/video/db"
)

var errInvalidDelivery = core.APIError{Status: http.StatusBadRequest, Code: "invalid_delivery"}

// originParts splits ORIGIN_URL into the host a CDN pulls from and the path segments live under.
func originParts(originURL string) (host, path string) {
	u, err := url.Parse(originURL)
	if err != nil {
		return originURL, ""
	}
	return u.Scheme + "://" + u.Host, strings.TrimSuffix(u.Path, "/")
}

// Delivery modes: our origin, the workspace's own CDN, or the managed CDN an application built on ulka-vms runs.
const (
	modeOrigin  = "origin"
	modeCustom  = "custom"
	modeManaged = "ulka_cdn"
)

// providers are the CDNs whose setup steps the console shows for a custom CDN; "ulka" is Ulka CDN.
var providers = []string{"ulka", "cloudflare", "cloudfront", "bunny", "fastly", "akamai", "other"}

// ManagedCDN is a CDN an application built on ulka-vms runs for its workspaces (Ulka CDN, in Ulka). With one,
// delivery offers it in place of a workspace's own CDN.
type ManagedCDN interface {
	// Create makes a distribution in the workspace that pulls from originHost, and returns its id.
	Create(ctx context.Context, t core.TenantTx, originHost string) (pgtype.UUID, error)
	// State is the distribution as it is now; false once it was deleted.
	State(ctx context.Context, t core.TenantTx, id pgtype.UUID) (Distribution, bool, error)
}

// Distribution is a managed CDN distribution as delivery shows it.
type Distribution struct {
	ID       pgtype.UUID `json:"id"`
	Name     string      `json:"name"`
	Hostname string      `json:"hostname"`
	Active   bool        `json:"active"` // serving everywhere; until then segments come from the origin
}

// modes are the delivery modes this server offers.
func (s *module) modes() []string {
	if s.managed != nil {
		return []string{modeOrigin, modeManaged}
	}
	return []string{modeOrigin, modeCustom}
}

// segmentBase is where viewers fetch segments for a tenant: its own CDN, its managed distribution once that is live
// everywhere (until then, the origin, so playback never breaks), or our origin.
func segmentBase(originURL string, d delivery) string {
	_, path := originParts(originURL)
	switch {
	case d.Mode == modeCustom && d.CustomUrl.Valid:
		return d.CustomUrl.String + path
	case d.Mode == modeManaged && d.Distribution != nil && d.Distribution.Active:
		return "https://" + d.Distribution.Hostname + path
	}
	return originURL
}

// deliveryFor reads a tenant's delivery choice in q's transaction; no choice means our origin.
func (s *module) deliveryFor(ctx context.Context, q tx) (string, error) {
	d, err := s.getDelivery(ctx, q)
	if errors.Is(err, pgx.ErrNoRows) {
		return s.OriginURL, nil
	}
	return segmentBase(s.OriginURL, d), err
}

type deliveryView struct {
	Mode      string   `json:"mode"`
	Modes     []string `json:"modes"` // the modes this server offers
	CustomURL string   `json:"custom_url"`
	Provider  string   `json:"provider"` // for custom: which CDN, so its setup steps can be shown
	// Where a customer's own CDN should pull from, and the path segments are under.
	Origin       string        `json:"origin"`
	Distribution *Distribution `json:"cdn_distribution"`
	Serving      string        `json:"serving"` // the segment address viewers get right now
}

func (s *module) deliveryView(ctx context.Context, q tx) (deliveryView, error) {
	host, _ := originParts(s.OriginURL)
	v := deliveryView{Mode: modeOrigin, Modes: s.modes(), Provider: "other", Origin: host, Serving: s.OriginURL}
	d, err := s.getDelivery(ctx, q)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, nil
	}
	if err != nil {
		return v, err
	}
	v.Mode, v.CustomURL, v.Provider, v.Distribution, v.Serving = d.Mode, d.CustomUrl.String, d.Provider, d.Distribution, segmentBase(s.OriginURL, d)
	return v, nil
}

func (s *module) getDeliveryHandler(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var out deliveryView
	err := inTenant(r.Context(), s.Pool, p.TenantID, func(q tx) (err error) {
		out, err = s.deliveryView(r.Context(), q)
		return err
	})
	if err != nil {
		core.InternalError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, out)
}

// putDelivery chooses where segments are served from. Choosing the managed CDN makes a distribution for the video
// origin in the workspace (or reuses the one made before), so its traffic shows with the rest of its CDN use.
func (s *module) putDelivery(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var in struct {
		Mode      string `json:"mode"`
		CustomURL string `json:"custom_url"`
		Provider  string `json:"provider"`
	}
	if !core.Decode(w, r, &in) {
		return
	}
	if in.Provider == "" {
		in.Provider = "other"
	}
	if !slices.Contains(s.modes(), in.Mode) || !slices.Contains(providers, in.Provider) {
		core.RespondError(w, r, errInvalidDelivery)
		return
	}
	custom := pgtype.Text{}
	if in.Mode == modeCustom {
		u, ok := core.CDNURL(in.CustomURL)
		if !ok {
			core.RespondError(w, r, errInvalidDelivery)
			return
		}
		custom = pgtype.Text{String: u, Valid: true}
	}
	var out deliveryView
	err := inTenant(r.Context(), s.Pool, p.TenantID, func(q tx) error {
		var distribution pgtype.UUID
		cur, err := s.getDelivery(r.Context(), q)
		if err == nil && cur.Distribution != nil {
			distribution = cur.CdnDistributionID // keep the distribution made before, whichever mode is chosen now
		} else if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if in.Mode == modeManaged && !distribution.Valid {
			host, _ := originParts(s.OriginURL)
			if distribution, err = s.managed.Create(r.Context(), q.TenantTx, host); err != nil {
				return err
			}
		}
		if err := q.SetVideoDelivery(r.Context(), db.SetVideoDeliveryParams{Mode: in.Mode, CustomUrl: custom, Provider: in.Provider, CdnDistributionID: distribution}); err != nil {
			return err
		}
		out, err = s.deliveryView(r.Context(), q)
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, out)
}

func (s *module) videoStats(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var out db.VideoStatsRow
	err := inTenant(r.Context(), s.Pool, p.TenantID, func(q tx) (err error) {
		out, err = q.VideoStats(r.Context())
		return err
	})
	if err != nil {
		core.InternalError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, out)
}

// delivery is the tenant's choice with its managed distribution as it is now, if it has one.
type delivery struct {
	db.GetVideoDeliveryRow
	Distribution *Distribution
}

func (s *module) getDelivery(ctx context.Context, q tx) (delivery, error) {
	row, err := q.GetVideoDelivery(ctx)
	if err != nil || s.managed == nil || !row.CdnDistributionID.Valid {
		return delivery{GetVideoDeliveryRow: row}, err
	}
	st, ok, err := s.managed.State(ctx, q.TenantTx, row.CdnDistributionID)
	d := delivery{GetVideoDeliveryRow: row}
	if ok {
		st.ID = row.CdnDistributionID
		d.Distribution = &st
	}
	return d, err
}
