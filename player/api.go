package player

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/video"
)

type module struct{ *core.Deps }

// Routes registers the player's settings (console only); the embed's config is served by video on the player host.
func Routes(mux *http.ServeMux, d *core.Deps) {
	s := &module{d}
	mux.HandleFunc("GET /v1/libraries/{id}/player", s.Auth("video:read", s.getLibraryPlayer))
	mux.HandleFunc("PUT /v1/libraries/{id}/player", s.Auth("video:write", s.putLibraryPlayer))
	mux.HandleFunc("GET /v1/player/templates", s.Auth("video:read", func(w http.ResponseWriter, r *http.Request, _ core.Principal) {
		core.WriteJSON(w, http.StatusOK, map[string]any{"data": Templates})
	}))
}

var errInvalidTemplate = core.APIError{Status: http.StatusBadRequest, Code: "invalid_template"}

func (s *module) getLibraryPlayer(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var raw []byte
	err := s.WithPathID(r, p, func(t core.TenantTx, id pgtype.UUID) (err error) {
		raw, err = video.LibraryPlayer(r.Context(), t, id)
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		err = errNotFound
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, settingsOf(raw))
}

func (s *module) putLibraryPlayer(w http.ResponseWriter, r *http.Request, p core.Principal) {
	if !p.Can("video:write") {
		core.RespondError(w, r, core.ErrForbidden)
		return
	}
	in := defaults()
	if !core.Decode(w, r, &in) {
		return
	}
	if err := in.validate(); err != nil {
		core.RespondError(w, r, err)
		return
	}
	doc, err := json.Marshal(in)
	if err != nil {
		core.InternalError(w, r, err)
		return
	}
	err = s.WithPathID(r, p, func(t core.TenantTx, id pgtype.UUID) error {
		return video.SetLibraryPlayer(r.Context(), t, id, doc)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		err = errNotFound
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, in)
}

// serveConfig answers a video's config.json: player settings (or a template's, ?template=), title, chapters, the signed watermark, addresses relative
// to the video's own. ?ref= (document.referrer) must be an allowed website when the library lists them: a hotlink guard.
func serveConfig(w http.ResponseWriter, r *http.Request, v video.Viewing) {
	if err := v.Access.WebsiteAllowed(r.URL.Query().Get("ref")); err != nil {
		core.RespondError(w, r, err)
		return
	}
	settings := settingsOf(v.Player)
	// ?template= swaps the library's controls and start for a template's, keeping its look.
	if key := r.URL.Query().Get("template"); key != "" {
		b, ok := template(key)
		if !ok {
			core.RespondError(w, r, errInvalidTemplate)
			return
		}
		settings.Behaviour = b
	}
	core.WriteJSON(w, http.StatusOK, map[string]any{
		"settings": settings, "title": v.Title, "policy": v.Policy, "status": v.Status, "duration_seconds": v.DurationSeconds,
		"stream": v.Link("playlist.m3u8"), "poster": v.Poster, "storyboard": v.Link("storyboard.vtt"), "chapters": v.Chapters, "watermark": v.Watermark,
	})
}
