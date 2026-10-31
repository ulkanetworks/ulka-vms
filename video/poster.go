package video

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"strconv"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/video/db"
)

var errInvalidTime = core.APIError{Status: http.StatusBadRequest, Code: "invalid_time"}

// suggestedAt are the frames offered as covers, as shares of the length; the first is the default.
var suggestedAt = []float64{posterAt, .25, .4, .55, .7, .85}

// PosterView is a video's cover: the default frame, a frame chosen by time, or an uploaded picture; with the frames
// offered to choose from (empty until the video's length is known).
type PosterView struct {
	Source      string    `json:"source"` // default, frame or upload
	Time        *float64  `json:"time"`   // the frame's time in seconds; null for an upload or an unknown length
	Suggestions []float64 `json:"suggestions"`
}

func posterView(a db.Asset) PosterView {
	v := PosterView{Source: "default", Suggestions: []float64{}}
	if a.DurationSeconds.Valid {
		for _, f := range suggestedAt {
			v.Suggestions = append(v.Suggestions, math.Round(a.DurationSeconds.Float64*f*10)/10)
		}
	}
	switch {
	case a.PosterUploadedAt.Valid:
		v.Source = "upload"
	case a.PosterTime.Valid:
		v.Source, v.Time = "frame", &a.PosterTime.Float64
	case len(v.Suggestions) > 0:
		v.Time = &v.Suggestions[0]
	}
	return v
}

// posterVersion names the current thumbnail choice, for its address: a new choice is a new address, so browsers and
// CDNs never show the old picture, while unrelated edits leave the cached one alone.
func posterVersion(a db.Asset) string {
	switch {
	case a.PosterUploadedAt.Valid:
		return "u" + strconv.FormatInt(a.PosterUploadedAt.Time.Unix(), 10)
	case a.PosterTime.Valid:
		return "t" + strconv.FormatFloat(a.PosterTime.Float64, 'f', -1, 64)
	}
	return "default"
}

// setPoster makes the frame at time (seconds) the cover, or the default frame again with {"time": null}.
func (s *module) setPoster(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var in struct {
		Time *float64 `json:"time"`
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
		t := pgtype.Float8{}
		if in.Time != nil {
			if !a.DurationSeconds.Valid {
				return errNotReady
			}
			if math.IsNaN(*in.Time) || *in.Time < 0 || *in.Time > a.DurationSeconds.Float64 {
				return errInvalidTime
			}
			t = pgtype.Float8{Float64: *in.Time, Valid: true}
		}
		if _, err := q.SetPosterFrame(r.Context(), db.SetPosterFrameParams{ID: id, PosterTime: t}); err != nil {
			return err
		}
		view, err = LoadAssetView(r.Context(), q, id)
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		err = errNotFound
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, view)
}

// uploadPoster makes a picture the cover: the request body is the image (JPEG, PNG, WebP or GIF, up to 25 MB). It
// is redrawn through s.convert and kept as JPEG and WebP at most 1920 wide.
func (s *module) uploadPoster(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var id pgtype.UUID
	if id.Scan(r.PathValue("id")) != nil {
		core.RespondError(w, r, errNotFound)
		return
	}
	// The video must exist (and be this workspace's) before anything is read or stored.
	if err := inTenant(r.Context(), s.Pool, p.TenantID, func(q tx) error { _, err := q.GetAsset(r.Context(), id); return err }); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			err = errNotFound
		}
		core.RespondError(w, r, err)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxCoverBytes+1))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			core.RespondError(w, r, errImageTooLarge)
			return
		}
		core.RespondError(w, r, err)
		return
	}
	prefix := p.TenantID.String() + "/" + id.String() + "/images/cover."
	for _, f := range []struct {
		ext     string
		quality int
	}{{"jpg", 85}, {"webp", 80}} {
		out, err := s.convert(r.Context(), body, 1920, f.quality, f.ext)
		if err != nil {
			core.RespondError(w, r, err)
			return
		}
		key := prefix + f.ext
		if _, err := s.Store.S3.PutObject(r.Context(), &s3.PutObjectInput{Bucket: &s.Store.Bucket, Key: &key, Body: bytes.NewReader(out)}); err != nil {
			core.InternalError(w, r, err)
			return
		}
	}
	var view AssetView
	err = inTenant(r.Context(), s.Pool, p.TenantID, func(q tx) error {
		if _, err := q.SetPosterUploaded(r.Context(), id); err != nil {
			return err
		}
		view, err = LoadAssetView(r.Context(), q, id)
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		err = errNotFound // trashed meanwhile
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, view)
}

// uploadedPoster serves the uploaded cover in ext, resized to width when asked (each size made once, kept per upload).
func (s *module) uploadedPoster(ctx context.Context, p playback, width int, ext string) ([]byte, error) {
	stored := p.prefix() + "images/cover." + ext
	if width == 0 {
		return s.Store.ReadObject(ctx, stored)
	}
	key := fmt.Sprintf("%simages/thumbs/cover_%d_%d.%s", p.prefix(), p.posterUploaded.Time.Unix(), width, ext)
	if b, err := s.Store.ReadObject(ctx, key); err == nil {
		return b, nil
	}
	full, err := s.Store.ReadObject(ctx, stored)
	if err != nil {
		return nil, err
	}
	b, err := s.convert(ctx, full, width, 0, ext)
	if err != nil {
		return nil, err
	}
	if _, err := s.Store.S3.PutObject(ctx, &s3.PutObjectInput{Bucket: &s.Store.Bucket, Key: &key, Body: bytes.NewReader(b)}); err != nil {
		slog.WarnContext(ctx, "could not keep a resized cover", "err", err) // served anyway; made again next time
	}
	return b, nil
}
