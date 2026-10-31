package video

import (
	"encoding/json"
	"math"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/video/db"
)

// A video's own words and labels (docs.ulka.co's names): metadata is key/value pairs an app attaches, like its
// own id; chapters mark parts of the video for the player's timeline.
type MetaPair struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type Chapter struct {
	Title     string `json:"title"`
	StartTime int    `json:"start_time"` // seconds
	EndTime   int    `json:"end_time"`
}

var metaKeyRe = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

var (
	errInvalidDescription = core.APIError{Status: http.StatusBadRequest, Code: "invalid_video_description"}
	errInvalidTags        = core.APIError{Status: http.StatusBadRequest, Code: "invalid_tags"}
	errInvalidMetadata    = core.APIError{Status: http.StatusBadRequest, Code: "invalid_metadata"}
	errInvalidChapters    = core.APIError{Status: http.StatusBadRequest, Code: "invalid_chapters"}
)

// cleanTags trims each tag and drops repeats (ignoring case), keeping the first spelling.
func cleanTags(in []string) ([]string, error) {
	out := []string{}
	for _, t := range in {
		t = strings.TrimSpace(t)
		if t == "" || utf8.RuneCountInString(t) > core.MaxTag || strings.Contains(t, ",") {
			return nil, errInvalidTags
		}
		if !slices.ContainsFunc(out, func(o string) bool { return strings.EqualFold(o, t) }) {
			out = append(out, t)
		}
	}
	if len(out) > core.MaxTags {
		return nil, errInvalidTags
	}
	return out, nil
}

func cleanMetadata(in []MetaPair) ([]MetaPair, error) {
	if len(in) > core.MaxMetadata {
		return nil, errInvalidMetadata
	}
	out := make([]MetaPair, 0, len(in))
	for _, m := range in {
		m.Key, m.Value = strings.TrimSpace(m.Key), strings.TrimSpace(m.Value)
		if len(m.Key) > core.MaxMetaKey || !metaKeyRe.MatchString(m.Key) || utf8.RuneCountInString(m.Value) > core.MaxMetaValue ||
			slices.ContainsFunc(out, func(o MetaPair) bool { return o.Key == m.Key }) {
			return nil, errInvalidMetadata
		}
		out = append(out, m)
	}
	return out, nil
}

// cleanChapters orders chapters by start and refuses overlaps and ones past the video's end (when it is known).
func cleanChapters(in []Chapter, duration pgtype.Float8) ([]Chapter, error) {
	if len(in) > core.MaxChapters {
		return nil, errInvalidChapters
	}
	out := slices.Clone(in)
	slices.SortFunc(out, func(a, b Chapter) int { return a.StartTime - b.StartTime })
	end := math.MaxInt
	if duration.Valid {
		end = int(math.Ceil(duration.Float64))
	}
	for i := range out {
		c := &out[i]
		c.Title = strings.TrimSpace(c.Title)
		if c.Title == "" || utf8.RuneCountInString(c.Title) > 100 || c.StartTime < 0 || c.EndTime <= c.StartTime || c.EndTime > end ||
			(i > 0 && c.StartTime < out[i-1].EndTime) {
			return nil, errInvalidChapters
		}
	}
	return out, nil
}

// putChapters replaces a video's chapters as a whole; an empty list removes them.
func (s *module) putChapters(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var in struct {
		Chapters []Chapter `json:"chapters"`
	}
	if !core.Decode(w, r, &in) {
		return
	}
	var view AssetView
	err := withPathID(s.Deps, r, p, func(q tx, id pgtype.UUID) error {
		a, err := q.GetAsset(r.Context(), id)
		if err != nil {
			return err
		}
		if a.DeletedAt.Valid {
			return errNotFound
		}
		chapters, err := cleanChapters(in.Chapters, a.DurationSeconds)
		if err != nil {
			return err
		}
		raw, err := json.Marshal(chapters)
		if err != nil {
			return err
		}
		if err := q.SetAssetChapters(r.Context(), db.SetAssetChaptersParams{ID: id, Chapters: raw}); err != nil {
			return err
		}
		view, err = LoadAssetView(r.Context(), q, id)
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, view)
}
