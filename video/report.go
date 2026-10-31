package video

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/video/db"
)

// checkInfo is what a viewer's own check needs from the server: its clock, who the viewer is, and whether the address
// they opened would play, rule by rule. It answers even when the address wouldn't play; that is what it explains.
func (s *module) checkInfo(w http.ResponseWriter, r *http.Request, lib, vid pgtype.UUID) {
	w.Header().Set("Cache-Control", "no-store")
	c, err := s.resolve(r.Context(), lib, vid)
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	viewer := core.ClientIP(r, s.TrustedProxies)
	var findings []linkFinding
	var country string
	err = inTenant(r.Context(), s.Pool, c.p.tenantID, func(q tx) error {
		asset, err := q.GetAsset(r.Context(), vid)
		if err != nil {
			return err
		}
		l, err := q.PlayerLibrary(r.Context(), vid)
		if err != nil {
			return err
		}
		access := Access{AllowedDomains: l.AllowedDomains, BlockedDomains: l.BlockedDomains, CountryMode: l.CountryMode, Countries: l.Countries}
		findings, _, country, err = s.explainLink(r.Context(), asset, access, "/"+lib.String()+"/"+vid.String()+"?"+r.URL.RawQuery, r.URL.Query().Get("ref"), &viewer)
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	plays := true
	for _, f := range findings {
		plays = plays && f.State != "problem"
	}
	core.WriteJSON(w, http.StatusOK, map[string]any{
		"server_time": time.Now().UTC(),
		"viewer":      map[string]string{"ip": viewer.String(), "country": country},
		"status":      c.p.status,
		"findings":    findings,
		"plays":       plays,
	})
}

const reportCodeChars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

func reportCode() string {
	b := make([]byte, 6)
	rand.Read(b)
	for i := range b {
		b[i] = reportCodeChars[int(b[i])%len(reportCodeChars)]
	}
	return "UL-" + string(b)
}

// playReport keeps what a viewer's check found under a short code they can give support. No account is needed, so
// one viewer sends at most one report a video every 30 seconds.
func (s *module) playReport(w http.ResponseWriter, r *http.Request) {
	playbackHeaders(w)
	lib, vid, file, ok := playParts(r)
	if !ok || file != "report" {
		core.WriteError(w, http.StatusNotFound, "not_found")
		return
	}
	var in struct {
		Plays   bool            `json:"plays"`
		Results json.RawMessage `json:"results"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 32<<10)
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || len(in.Results) < 2 || in.Results[0] != '[' {
		core.WriteError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	c, err := s.resolve(r.Context(), lib, vid)
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	viewer := core.ClientIP(r, s.TrustedProxies)
	country := ""
	if s.Geo != nil && viewer.IsValid() {
		country = s.Geo.Country(viewer)
	}
	ua := r.UserAgent()
	if len(ua) > 512 {
		ua = ua[:512]
	}
	code := reportCode()
	err = inTenant(r.Context(), s.Pool, c.p.tenantID, func(q tx) error {
		recent, err := q.RecentPlaybackReport(r.Context(), db.RecentPlaybackReportParams{AssetID: vid, Ip: viewer.String()})
		if err != nil {
			return err
		}
		if recent {
			return errReportTooSoon
		}
		return q.AddPlaybackReport(r.Context(), db.AddPlaybackReportParams{AssetID: vid, Code: code, Ip: viewer.String(), Country: country,
			UserAgent: ua, Plays: in.Plays, Results: in.Results})
	})
	if pe := (*pgconn.PgError)(nil); errors.As(err, &pe) && pe.Code == "23505" {
		err = errReportTooSoon // a code taken already: one in a billion; the viewer sends again
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusCreated, map[string]string{"code": code})
}

var errReportTooSoon = core.APIError{Status: http.StatusTooManyRequests, Code: "report_too_soon"}

type reportView struct {
	Code      string          `json:"code"`
	IP        string          `json:"ip"`
	Country   string          `json:"country"`
	UserAgent string          `json:"user_agent"`
	Plays     bool            `json:"plays"`
	Results   json.RawMessage `json:"results"`
	CreatedAt time.Time       `json:"created_at"`
}

func (s *module) listPlaybackReports(w http.ResponseWriter, r *http.Request, pr core.Principal) {
	c, err := core.ParseCursor(r)
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	var rows []db.ListPlaybackReportsRow
	var total int64
	err = withPathID(s.Deps, r, pr, func(q tx, id pgtype.UUID) (err error) {
		if _, err = q.GetAsset(r.Context(), id); err != nil {
			return err
		}
		rows, err = q.ListPlaybackReports(r.Context(), db.ListPlaybackReportsParams{AssetID: id, AfterAt: c.At, AfterCode: pgtype.Text{String: c.ID, Valid: c.ID != ""}, Lim: c.Fetch()})
		if err != nil {
			return err
		}
		total, err = q.CountPlaybackReports(r.Context(), id)
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	views := make([]reportView, len(rows))
	for i, row := range rows {
		views[i] = reportView{row.Code, row.Ip, row.Country, row.UserAgent, row.Plays, row.Results, row.CreatedAt.Time}
	}
	core.WriteJSON(w, http.StatusOK, core.PagedTotal(views, c, func(v reportView) (time.Time, string) { return v.CreatedAt, v.Code }, total))
}

// getPlaybackReport finds one of the workspace's reports by the code a viewer gave, whatever the video.
func (s *module) getPlaybackReport(w http.ResponseWriter, r *http.Request, pr core.Principal) {
	var row db.GetPlaybackReportRow
	err := inTenant(r.Context(), s.Pool, pr.TenantID, func(q tx) (err error) {
		row, err = q.GetPlaybackReport(r.Context(), strings.TrimSpace(r.PathValue("code")))
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		core.WriteError(w, http.StatusNotFound, "not_found")
		return
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, map[string]any{
		"code": row.Code, "asset_id": row.AssetID, "title": row.Title, "ip": row.Ip, "country": row.Country,
		"user_agent": row.UserAgent, "plays": row.Plays, "results": row.Results, "created_at": row.CreatedAt.Time,
	})
}
