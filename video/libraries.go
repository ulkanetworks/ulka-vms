package video

import (
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/video/db"
)

var (
	errInvalidLibrary   = core.APIError{Status: http.StatusBadRequest, Code: "invalid_library"}
	errLibraryNameTaken = core.APIError{Status: http.StatusConflict, Code: "library_name_taken"}
	errLibraryNotEmpty  = core.APIError{Status: http.StatusConflict, Code: "library_not_empty"}
	errLibraryDefault   = core.APIError{Status: http.StatusConflict, Code: "library_is_default"}
	errInvalidDomains   = core.APIError{Status: http.StatusBadRequest, Code: "invalid_domains"}
	errInvalidFolder    = core.APIError{Status: http.StatusBadRequest, Code: "invalid_folder"}
	errFolderNameTaken  = core.APIError{Status: http.StatusConflict, Code: "folder_name_taken"}
	errInvalidMove      = core.APIError{Status: http.StatusBadRequest, Code: "invalid_move"}
)

type LibraryView struct {
	ID                    pgtype.UUID `json:"id"`
	Name                  string      `json:"name"`
	Description           string      `json:"description"`
	IsDefault             bool        `json:"is_default"`
	DefaultPlaybackPolicy string      `json:"default_playback_policy"`
	PresetTemplate        string      `json:"preset_template"` // the built-in preset in use, unless PresetID is set
	PresetID              pgtype.UUID `json:"preset_id"`       // the workspace's own preset in use, or null
	MP4Downloads          bool        `json:"mp4_downloads"`
	Access
	Inherits     []string     `json:"inherits"` // groups that follow the workspace's video defaults: player, transcoding, security
	Videos       int32        `json:"videos"`
	Trashed      int32        `json:"trashed"`
	Minutes      float64      `json:"minutes"`
	StorageBytes int64        `json:"storage_bytes"` // source sizes of the live videos whose original still exists
	ByStatus     StatusCounts `json:"by_status"`     // live videos by state
	CreatedAt    time.Time    `json:"created_at"`
	UpdatedAt    time.Time    `json:"updated_at"`
}

// StatusCounts: ready is `complete`; processing is waiting, processing and playable-but-finishing.
type StatusCounts struct {
	All        int32 `json:"all"`
	Ready      int32 `json:"ready"`
	Processing int32 `json:"processing"`
	Errored    int32 `json:"errored"`
}

func libraryView(r db.ListLibrariesRow) LibraryView {
	inherits := r.Inherits
	if inherits == nil {
		inherits = []string{}
	}
	return LibraryView{r.ID, r.Name, r.Description, r.IsDefault, r.DefaultPlaybackPolicy, r.PresetTemplate, r.PresetID, r.Mp4Downloads,
		Access{r.AllowedDomains, r.BlockedDomains, r.CountryMode, r.Countries}.orEmpty(), inherits,
		r.Videos, r.Trashed, r.Minutes, r.StorageBytes, StatusCounts{r.Videos, r.ReadyVideos, r.ProcessingVideos, r.ErroredVideos}, r.CreatedAt.Time, r.UpdatedAt.Time}
}

// libraries reads one library (id valid) or all, making the workspace's default one first if it has none yet.
func libraries(r *http.Request, q tx, id pgtype.UUID) ([]LibraryView, error) {
	if _, err := q.EnsureDefaultLibrary(r.Context()); err != nil {
		return nil, err
	}
	rows, err := q.ListLibraries(r.Context(), id)
	out := make([]LibraryView, len(rows))
	for i, row := range rows {
		out[i] = libraryView(row)
	}
	return out, err
}

func (s *module) listLibraries(w http.ResponseWriter, r *http.Request, p core.Principal) {
	c, err := core.ParseCursor(r)
	var after pgtype.UUID
	if err == nil {
		after, err = c.AfterUUID()
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	var out []LibraryView
	var total int64
	err = inScope(r.Context(), s.Pool, p, func(q tx) error {
		if _, err := q.EnsureDefaultLibrary(r.Context()); err != nil {
			return err
		}
		rows, err := q.ListLibrariesPage(r.Context(), db.ListLibrariesPageParams{Pattern: c.Like(), AfterAt: c.At, AfterID: after, Lim: c.Fetch()})
		for _, row := range rows {
			out = append(out, libraryView(db.ListLibrariesRow(row)))
		}
		if err != nil {
			return err
		}
		total, err = q.CountLibraries(r.Context(), c.Like())
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, core.PagedTotal(out, c, func(l LibraryView) (time.Time, string) { return l.CreatedAt, l.ID.String() }, total))
}

func (s *module) getLibrary(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var out []LibraryView
	err := withPathID(s.Deps, r, p, func(q tx, id pgtype.UUID) (err error) {
		out, err = libraries(r, q, id)
		if err == nil && len(out) == 0 {
			err = errNotFound
		}
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, out[0])
}

// uniqueName turns a duplicate-name violation into its API error.
func uniqueName(err error, taken core.APIError) error {
	if pgErr := (*pgconn.PgError)(nil); errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return taken
	}
	return err
}

func validName(s string) bool { return s != "" && utf8.RuneCountInString(s) <= core.MaxName }

func (s *module) createLibrary(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var in struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if !p.Can("video:write") {
		core.RespondError(w, r, core.ErrForbidden)
		return
	}
	if !core.Decode(w, r, &in) {
		return
	}
	in.Name, in.Description = strings.TrimSpace(in.Name), strings.TrimSpace(in.Description)
	if !validName(in.Name) || utf8.RuneCountInString(in.Description) > core.MaxDescription {
		core.RespondError(w, r, errInvalidLibrary)
		return
	}
	var out []LibraryView
	err := inScope(r.Context(), s.Pool, p, func(q tx) error {
		if _, err := q.EnsureDefaultLibrary(r.Context()); err != nil {
			return err
		}
		if err := q.EnsureVideoDefaults(r.Context()); err != nil {
			return err
		}
		id, err := q.CreateLibrary(r.Context(), db.CreateLibraryParams{Name: in.Name, Description: in.Description})
		if err != nil {
			return uniqueName(err, errLibraryNameTaken)
		}
		out, err = libraries(r, q, id)
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusCreated, out[0])
}

// updateLibrary changes the fields sent (name, description and the library's settings); the player has its own route.
func (s *module) updateLibrary(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var in struct {
		Name                  *string `json:"name"`
		Description           *string `json:"description"`
		DefaultPlaybackPolicy *string `json:"default_playback_policy"`
		MP4Downloads          *bool   `json:"mp4_downloads"`
		accessInput
		Inherit *struct {
			Player, Transcoding, Security *bool
		} `json:"inherit"` // true follows the workspace defaults again (copying them in), false stops following
	}
	if !p.Can("video:write") {
		core.RespondError(w, r, core.ErrForbidden)
		return
	}
	if !core.Decode(w, r, &in) {
		return
	}
	params := db.UpdateLibraryParams{}
	trim := func(v *string) pgtype.Text {
		if v == nil {
			return pgtype.Text{}
		}
		return pgtype.Text{String: strings.TrimSpace(*v), Valid: true}
	}
	params.Name, params.Description, params.DefaultPlaybackPolicy = trim(in.Name), trim(in.Description), trim(in.DefaultPlaybackPolicy)
	if (params.Name.Valid && !validName(params.Name.String)) || (params.Description.Valid && utf8.RuneCountInString(params.Description.String) > core.MaxDescription) ||
		(params.DefaultPlaybackPolicy.Valid && !validPolicy(params.DefaultPlaybackPolicy.String)) {
		core.RespondError(w, r, errInvalidLibrary)
		return
	}
	if in.MP4Downloads != nil {
		params.Mp4Downloads = pgtype.Bool{Bool: *in.MP4Downloads, Valid: true}
	}
	var err error
	if params.AllowedDomains, params.BlockedDomains, params.CountryMode, params.Countries, err = in.accessInput.clean(); err != nil {
		core.RespondError(w, r, err)
		return
	}
	// Writing a group's fields means the library no longer follows it; an explicit inherit decides after that.
	params.Drop = []string{}
	apply := []string{}
	if in.MP4Downloads != nil {
		params.Drop = append(params.Drop, groupTranscoding)
	}
	if in.DefaultPlaybackPolicy != nil || in.accessInput.touched() {
		params.Drop = append(params.Drop, groupSecurity)
	}
	if in.Inherit != nil {
		for g, v := range map[string]*bool{groupPlayer: in.Inherit.Player, groupTranscoding: in.Inherit.Transcoding, groupSecurity: in.Inherit.Security} {
			if v == nil {
				continue
			}
			if *v {
				apply = append(apply, g)
			} else {
				params.Drop = append(params.Drop, g)
			}
		}
	}
	var out []LibraryView
	err = withPathID(s.Deps, r, p, func(q tx, id pgtype.UUID) error {
		params.ID = id
		if _, err := q.UpdateLibrary(r.Context(), params); err != nil {
			return uniqueName(err, errLibraryNameTaken)
		}
		if len(apply) > 0 {
			if err := q.EnsureVideoDefaults(r.Context()); err != nil {
				return err
			}
			if _, err := q.ApplyLibraryDefaults(r.Context(), db.ApplyLibraryDefaultsParams{ID: id, Apply: apply}); err != nil {
				return err
			}
		}
		var err error
		out, err = libraries(r, q, id)
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, out[0])
}

// cleanDomains lowercases and checks a list of websites: example.com or *.example.com, no scheme, path or port.
func cleanDomains(in []string) ([]string, error) {
	out := make([]string, 0, len(in))
	for _, d := range in {
		d = strings.ToLower(strings.TrimSpace(d))
		host := strings.TrimPrefix(d, "*.")
		if !strings.Contains(host, ".") || !core.ValidHostname(host) || len(d) > 253 {
			return nil, errInvalidDomains
		}
		if !slices.Contains(out, d) {
			out = append(out, d)
		}
	}
	if len(out) > core.MaxAllowedWebsites {
		return nil, errInvalidDomains
	}
	return out, nil
}

// deleteLibrary removes an empty library other than the default; videos must be moved or deleted first.
func (s *module) deleteLibrary(w http.ResponseWriter, r *http.Request, p core.Principal) {
	if !p.Can("video:write") {
		core.RespondError(w, r, core.ErrForbidden)
		return
	}
	err := withPathID(s.Deps, r, p, func(q tx, id pgtype.UUID) error {
		if n, err := q.LibraryAssetCount(r.Context(), id); err != nil {
			return err
		} else if n > 0 {
			return errLibraryNotEmpty
		}
		n, err := q.DeleteLibrary(r.Context(), id)
		if err == nil && n == 0 {
			rows, gerr := q.ListLibraries(r.Context(), id)
			if gerr != nil {
				return gerr
			}
			if len(rows) == 0 {
				return errNotFound
			}
			return errLibraryDefault
		}
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		err = errNotFound
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
