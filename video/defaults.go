package video

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/transcoder"
	"github.com/ulkanetworks/ulka-vms/video/db"
)

// The groups of a library's settings that can follow the workspace defaults.
const (
	groupPlayer      = "player"
	groupTranscoding = "transcoding"
	groupSecurity    = "security"
)

// PlayerDocs is how the player module checks and shows the player settings document (video stores it, player owns its meaning).
type PlayerDocs struct {
	Clean func(raw []byte) ([]byte, error) // validates a document, returning the one to store
	View  func(stored []byte) any          // the full settings a stored document means
	// Config serves a video's config.json on the player host, once video has checked the viewer may watch.
	Config func(w http.ResponseWriter, r *http.Request, v Viewing)
}

type DefaultsView struct {
	Player         any    `json:"player"`
	PresetTemplate string `json:"preset_template"`
	MP4Downloads   bool   `json:"mp4_downloads"`
	Access
	DefaultPlaybackPolicy string `json:"default_playback_policy"`
}

func (s *module) defaultsOf(ctx context.Context, q tx) (DefaultsView, error) {
	d, err := q.GetVideoDefaults(ctx)
	if err != nil {
		return DefaultsView{}, err
	}
	return DefaultsView{s.player.View(d.Player), d.PresetTemplate, d.Mp4Downloads, Access{d.AllowedDomains, d.BlockedDomains, d.CountryMode, d.Countries}.orEmpty(), d.DefaultPlaybackPolicy}, nil
}

func (s *module) getDefaults(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var out DefaultsView
	err := inScope(r.Context(), s.Pool, p, func(q tx) (err error) {
		if err = q.EnsureVideoDefaults(r.Context()); err == nil {
			out, err = s.defaultsOf(r.Context(), q)
		}
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, out)
}

// putDefaults changes the fields sent and copies them into every library that follows their group.
func (s *module) putDefaults(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var in struct {
		Player         json.RawMessage `json:"player"`
		PresetTemplate *string         `json:"preset_template"`
		MP4Downloads   *bool           `json:"mp4_downloads"`
		accessInput
		DefaultPlaybackPolicy *string `json:"default_playback_policy"`
	}
	if !p.Can("video:write") {
		core.RespondError(w, r, core.ErrForbidden)
		return
	}
	if !core.Decode(w, r, &in) {
		return
	}
	var params db.UpdateVideoDefaultsParams
	if in.Player != nil {
		doc, err := s.player.Clean(in.Player)
		if err != nil {
			core.RespondError(w, r, err)
			return
		}
		params.Player = doc
	}
	if in.PresetTemplate != nil {
		t, ok := transcoder.TemplateByKey(*in.PresetTemplate)
		if !ok {
			core.RespondError(w, r, errInvalidPreset)
			return
		}
		params.PresetTemplate.String, params.PresetTemplate.Valid = t.Key, true
	}
	if in.DefaultPlaybackPolicy != nil {
		if !validPolicy(*in.DefaultPlaybackPolicy) {
			core.RespondError(w, r, errInvalidLibrary)
			return
		}
		params.DefaultPlaybackPolicy.String, params.DefaultPlaybackPolicy.Valid = *in.DefaultPlaybackPolicy, true
	}
	if in.MP4Downloads != nil {
		params.Mp4Downloads.Bool, params.Mp4Downloads.Valid = *in.MP4Downloads, true
	}
	var err error
	if params.AllowedDomains, params.BlockedDomains, params.CountryMode, params.Countries, err = in.accessInput.clean(); err != nil {
		core.RespondError(w, r, err)
		return
	}
	var out DefaultsView
	err = inScope(r.Context(), s.Pool, p, func(q tx) error {
		// The default library must exist first, so it is made with the platform values and then follows these.
		if _, err := q.EnsureDefaultLibrary(r.Context()); err != nil {
			return err
		}
		if err := q.EnsureVideoDefaults(r.Context()); err != nil {
			return err
		}
		if err := q.UpdateVideoDefaults(r.Context(), params); err != nil {
			return err
		}
		if err := q.PropagateVideoDefaults(r.Context()); err != nil {
			return err
		}
		var err error
		out, err = s.defaultsOf(r.Context(), q)
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, out)
}
