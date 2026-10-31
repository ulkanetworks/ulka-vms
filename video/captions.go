package video

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/video/db"
)

var (
	errInvalidCaptions  = core.APIError{Status: http.StatusBadRequest, Code: "invalid_captions"}
	errInvalidLanguage  = core.APIError{Status: http.StatusBadRequest, Code: "invalid_language"}
	errCaptionsTooLarge = core.APIError{Status: http.StatusRequestEntityTooLarge, Code: "captions_too_large"}
	errCaptionLimit     = core.APIError{Status: http.StatusConflict, Code: "caption_limit_reached"}
)

var (
	languageRe = regexp.MustCompile(`^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$`)
	// An SRT timing line: 00:00:01,000 --> 00:00:02,500, with optional settings after it.
	srtTiming = regexp.MustCompile(`(?m)^(\d{2}:\d{2}:\d{2}),(\d{3}) --> (\d{2}:\d{2}:\d{2}),(\d{3})`)
)

// toWebVTT accepts WebVTT as it is, and turns SRT into WebVTT: a header, and a dot for the comma in each timing.
// SRT's cue numbers stay; WebVTT reads them as cue identifiers.
func toWebVTT(b []byte) ([]byte, error) {
	s := strings.ReplaceAll(strings.TrimPrefix(string(b), "\ufeff"), "\r\n", "\n")
	if !strings.Contains(s, "-->") {
		return nil, errInvalidCaptions
	}
	if strings.HasPrefix(s, "WEBVTT") {
		return []byte(s), nil
	}
	if !srtTiming.MatchString(s) {
		return nil, errInvalidCaptions
	}
	return []byte("WEBVTT\n\n" + srtTiming.ReplaceAllString(s, "$1.$2 --> $3.$4")), nil
}

func captionKey(tenantID, assetID, captionID pgtype.UUID) string {
	return tenantID.String() + "/" + assetID.String() + "/captions/" + captionID.String() + ".vtt"
}

// addCaptions takes the caption file as the request body (WebVTT or SRT) and ?language= and ?name=.
func (s *module) addCaptions(w http.ResponseWriter, r *http.Request, p core.Principal) {
	language, name := r.URL.Query().Get("language"), strings.TrimSpace(r.URL.Query().Get("name"))
	if !languageRe.MatchString(language) {
		core.RespondError(w, r, errInvalidLanguage)
		return
	}
	if name == "" || utf8.RuneCountInString(name) > core.MaxName || strings.ContainsAny(name, "\"\n") {
		core.WriteError(w, http.StatusBadRequest, "invalid_name")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, core.MaxCaptionBytes+1))
	if err != nil {
		core.RespondError(w, r, errInvalidCaptions)
		return
	}
	if len(body) > core.MaxCaptionBytes {
		core.RespondError(w, r, errCaptionsTooLarge)
		return
	}
	vtt, err := toWebVTT(body)
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	var out db.CreateCaptionRow
	err = withPathID(s.Deps, r, p, func(q tx, id pgtype.UUID) error {
		if _, err := q.GetAsset(r.Context(), id); err != nil {
			return err
		}
		if out, err = q.CreateCaption(r.Context(), db.CreateCaptionParams{AssetID: id, Language: language, Name: name, Max: core.MaxCaptions}); errors.Is(err, pgx.ErrNoRows) {
			return errCaptionLimit
		} else if err != nil {
			return err
		}
		// Stored before the row commits, so a listed track always has its file.
		_, err = s.Store.S3.PutObject(r.Context(), &s3.PutObjectInput{Bucket: &s.Store.Bucket, Key: aws.String(captionKey(p.TenantID, id, out.ID)),
			Body: bytes.NewReader(vtt), ContentType: aws.String("text/vtt")})
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusCreated, out)
}

func (s *module) listCaptions(w http.ResponseWriter, r *http.Request, p core.Principal) {
	out := []db.ListCaptionsRow{}
	err := withPathID(s.Deps, r, p, func(q tx, id pgtype.UUID) error {
		if _, err := q.GetAsset(r.Context(), id); err != nil {
			return err
		}
		rows, err := q.ListCaptions(r.Context(), id)
		out = append(out, rows...)
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, map[string]any{"data": out})
}

func (s *module) deleteCaptions(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var captionID pgtype.UUID
	if captionID.Scan(r.PathValue("captionId")) != nil {
		core.WriteError(w, http.StatusNotFound, "not_found")
		return
	}
	err := withPathID(s.Deps, r, p, func(q tx, id pgtype.UUID) error {
		if n, err := q.DeleteCaption(r.Context(), db.DeleteCaptionParams{ID: captionID.String(), AssetID: id}); err != nil {
			return err
		} else if n == 0 {
			return pgx.ErrNoRows
		}
		_, err := s.Store.S3.DeleteObject(r.Context(), &s3.DeleteObjectInput{Bucket: &s.Store.Bucket, Key: aws.String(captionKey(p.TenantID, id, captionID))})
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// withCaptions lists a video's caption tracks in its master playlist: one subtitles group every quality points at.
func withCaptions(master []byte, captions []db.ListCaptionsRow, uri func(db.ListCaptionsRow) string) []byte {
	if len(captions) == 0 {
		return master
	}
	var media strings.Builder
	for _, c := range captions {
		fmt.Fprintf(&media, "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=%q,LANGUAGE=%q,DEFAULT=NO,AUTOSELECT=YES,URI=%q\n", c.Name, c.Language, uri(c))
	}
	var out strings.Builder
	added := false
	for _, line := range strings.SplitAfter(string(master), "\n") {
		if strings.HasPrefix(line, "#EXT-X-STREAM-INF:") {
			if !added {
				out.WriteString(media.String())
				added = true
			}
			line = strings.TrimRight(line, "\n") + ",SUBTITLES=\"subs\"\n"
		}
		out.WriteString(line)
	}
	return []byte(out.String())
}

// captionPlaylist is the one-segment playlist HLS wants around a WebVTT file.
func captionPlaylist(duration float64, vttURI string) []byte {
	return fmt.Appendf(nil, "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:%d\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:%.3f,\n%s\n#EXT-X-ENDLIST\n",
		int(math.Ceil(duration)), duration, vttURI)
}

// captionTrack serves captions_<caption>.m3u8, with the same access as the video.
func (s *module) captionTrack(w http.ResponseWriter, r *http.Request, p playback, captionID string) {
	var id pgtype.UUID
	if id.Scan(captionID) != nil || s.lookupCaption(r, p, id) != nil {
		core.WriteError(w, http.StatusNotFound, "not_found")
		return
	}
	s.writePlaylist(w, p, captionPlaylist(p.duration, p.link("captions/"+captionID+".vtt")))
}

func (s *module) lookupCaption(r *http.Request, p playback, id pgtype.UUID) error {
	return inTenant(r.Context(), s.Pool, p.tenantID, func(q tx) error {
		ok, err := q.HasCaption(r.Context(), db.HasCaptionParams{AssetID: p.assetID, ID: id.String()})
		if err == nil && !ok {
			err = pgx.ErrNoRows
		}
		return err
	})
}

// captionFile serves captions/<caption>.vtt.
func (s *module) captionFile(w http.ResponseWriter, r *http.Request, p playback, file string) {
	var id pgtype.UUID
	name, ok := strings.CutSuffix(file, ".vtt")
	if !ok || id.Scan(name) != nil || s.lookupCaption(r, p, id) != nil {
		core.WriteError(w, http.StatusNotFound, "not_found")
		return
	}
	body, err := s.Store.ReadObject(r.Context(), captionKey(p.tenantID, p.assetID, id))
	if nsk := (*types.NoSuchKey)(nil); errors.As(err, &nsk) {
		core.WriteError(w, http.StatusNotFound, "not_found")
		return
	}
	if err != nil {
		core.InternalError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
	if p.policy == "public" {
		w.Header().Set("Cache-Control", "public, max-age=60")
	} else {
		w.Header().Set("Cache-Control", "private, max-age=10")
	}
	w.Write(body)
}
