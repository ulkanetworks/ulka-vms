package video

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/transcoder"
	"github.com/ulkanetworks/ulka-vms/video/db"
)

var (
	errInvalidPreset   = core.APIError{Status: http.StatusBadRequest, Code: "invalid_preset"}
	errPresetNameTaken = core.APIError{Status: http.StatusConflict, Code: "preset_name_taken"}
	errPresetInUse     = core.APIError{Status: http.StatusConflict, Code: "preset_in_use"}
)

type PresetView struct {
	ID          pgtype.UUID `json:"id"`
	Name        string      `json:"name"`
	Description string      `json:"description"`
	Heights     []int32     `json:"heights"`
	Quality     string      `json:"quality"`
	UpdatedAt   time.Time   `json:"updated_at"`
}

// TranscodingView is what a library's Transcoding page shows: the built-in templates, the workspace's own presets,
// and which one new videos use.
type TranscodingView struct {
	Templates     []transcoder.Template `json:"templates"`
	Presets       []PresetView          `json:"presets"`
	ActiveKey     string                `json:"active_template"`
	ActivePreset  pgtype.UUID           `json:"active_preset"`
	QualityLevels []string              `json:"-"`
}

func (s *module) getTranscoding(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var out TranscodingView
	err := withPathID(s.Deps, r, p, func(q tx, id pgtype.UUID) (err error) {
		out, err = transcodingOf(r, q, id)
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, out)
}

func transcodingOf(r *http.Request, q tx, library pgtype.UUID) (TranscodingView, error) {
	libs, err := q.ListLibraries(r.Context(), library)
	if err != nil {
		return TranscodingView{}, err
	}
	if len(libs) == 0 {
		return TranscodingView{}, errNotFound
	}
	rows, err := q.ListPresets(r.Context(), library)
	out := TranscodingView{Templates: transcoder.Templates(), Presets: make([]PresetView, len(rows)), ActiveKey: libs[0].PresetTemplate, ActivePreset: libs[0].PresetID}
	for i, p := range rows {
		out.Presets[i] = PresetView{p.ID, p.Name, p.Description, p.Heights, p.Quality, p.UpdatedAt.Time}
	}
	return out, err
}

type presetInput struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
	Heights     []int32 `json:"heights"`
	Quality     *string `json:"quality"`
}

// clean checks the fields sent; create demands all of them, update only validates what is present.
func (in *presetInput) clean(create bool) error {
	if in.Name != nil {
		trimmed := strings.TrimSpace(*in.Name)
		in.Name = &trimmed
	}
	if in.Description != nil {
		trimmed := strings.TrimSpace(*in.Description)
		in.Description = &trimmed
	}
	if create && (in.Name == nil || in.Heights == nil || in.Quality == nil) {
		return errInvalidPreset
	}
	if (in.Name != nil && !validName(*in.Name)) || (in.Description != nil && len([]rune(*in.Description)) > 200) {
		return errInvalidPreset
	}
	if in.Heights != nil || in.Quality != nil {
		check := transcoder.Preset{Quality: transcoder.QualityBalanced}
		for _, h := range in.Heights {
			check.Heights = append(check.Heights, int(h))
		}
		if in.Heights == nil {
			check.Heights = []int{720}
		}
		if in.Quality != nil {
			check.Quality = transcoder.Quality(*in.Quality)
		}
		if !check.Clean() {
			return errInvalidPreset
		}
		if in.Heights != nil {
			in.Heights = in.Heights[:0]
			for _, h := range check.Heights {
				in.Heights = append(in.Heights, int32(h))
			}
		}
	}
	return nil
}

func (s *module) createPreset(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var in presetInput
	if !p.Can("video:write") {
		core.RespondError(w, r, core.ErrForbidden)
		return
	}
	if !core.Decode(w, r, &in) {
		return
	}
	if err := in.clean(true); err != nil {
		core.RespondError(w, r, err)
		return
	}
	var out PresetView
	err := withPathID(s.Deps, r, p, func(q tx, library pgtype.UUID) error {
		if libs, err := q.ListLibraries(r.Context(), library); err != nil {
			return err
		} else if len(libs) == 0 {
			return errNotFound
		}
		desc := ""
		if in.Description != nil {
			desc = *in.Description
		}
		id, err := q.CreatePreset(r.Context(), db.CreatePresetParams{LibraryID: library, Name: *in.Name, Description: desc, Heights: in.Heights, Quality: *in.Quality})
		if err != nil {
			return uniqueName(err, errPresetNameTaken)
		}
		out = PresetView{id, *in.Name, desc, in.Heights, *in.Quality, time.Now()}
		return nil
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusCreated, out)
}

func (s *module) updatePreset(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var in presetInput
	if !p.Can("video:write") {
		core.RespondError(w, r, core.ErrForbidden)
		return
	}
	if !core.Decode(w, r, &in) {
		return
	}
	if err := in.clean(false); err != nil {
		core.RespondError(w, r, err)
		return
	}
	params := db.UpdatePresetParams{Heights: in.Heights}
	if in.Name != nil {
		params.Name = pgtype.Text{String: *in.Name, Valid: true}
	}
	if in.Description != nil {
		params.Description = pgtype.Text{String: *in.Description, Valid: true}
	}
	if in.Quality != nil {
		params.Quality = pgtype.Text{String: *in.Quality, Valid: true}
	}
	err := withPathID(s.Deps, r, p, func(q tx, id pgtype.UUID) error {
		params.ID = id
		n, err := q.UpdatePreset(r.Context(), params)
		if err == nil && n == 0 {
			return errNotFound
		}
		return uniqueName(err, errPresetNameTaken)
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// deletePreset removes a preset that no library is using.
func (s *module) deletePreset(w http.ResponseWriter, r *http.Request, p core.Principal) {
	if !p.Can("video:write") {
		core.RespondError(w, r, core.ErrForbidden)
		return
	}
	err := withPathID(s.Deps, r, p, func(q tx, id pgtype.UUID) error {
		if used, err := q.PresetInUse(r.Context(), id); err != nil {
			return err
		} else if used {
			return errPresetInUse
		}
		n, err := q.DeletePreset(r.Context(), id)
		if err == nil && n == 0 {
			return errNotFound
		}
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// putTranscoding chooses what new videos in the library are encoded with: a template key or a preset id.
func (s *module) putTranscoding(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var in struct {
		Template string `json:"template"`
		PresetID string `json:"preset_id"`
	}
	if !p.Can("video:write") {
		core.RespondError(w, r, core.ErrForbidden)
		return
	}
	if !core.Decode(w, r, &in) {
		return
	}
	var preset pgtype.UUID
	template := transcoder.DefaultTemplate
	switch {
	case (in.Template == "") == (in.PresetID == ""):
		core.RespondError(w, r, errInvalidPreset) // exactly one
		return
	case in.PresetID != "":
		if preset.Scan(in.PresetID) != nil {
			core.RespondError(w, r, errInvalidPreset)
			return
		}
	default:
		t, ok := transcoder.TemplateByKey(in.Template)
		if !ok {
			core.RespondError(w, r, errInvalidPreset)
			return
		}
		template = t.Key
	}
	var out TranscodingView
	err := withPathID(s.Deps, r, p, func(q tx, id pgtype.UUID) error {
		if preset.Valid { // a preset of another library, or none, can't be chosen
			got, err := q.GetPreset(r.Context(), preset)
			if errors.Is(err, pgx.ErrNoRows) || (err == nil && got.LibraryID != id) {
				return errInvalidPreset
			}
			if err != nil {
				return err
			}
		}
		if n, err := q.SetLibraryPreset(r.Context(), db.SetLibraryPresetParams{ID: id, PresetTemplate: template, PresetID: preset}); err != nil {
			return err
		} else if n == 0 {
			return errNotFound
		}
		var err error
		out, err = transcodingOf(r, q, id)
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, out)
}
