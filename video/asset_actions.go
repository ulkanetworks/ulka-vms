package video

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/transcoder"
	"github.com/ulkanetworks/ulka-vms/video/db"
)

const maxBulk = 100 // videos one move, trash, restore or purge may name

// target is where a video goes: a library and a folder in it (nil folder: Home).
type target struct {
	LibraryID string `json:"library_id"` // absent: stay in the current library
	FolderID  string `json:"folder_id"`  // absent: Home when the library changes, else stay
}

// updateAsset changes a video's title, who can watch it, and/or moves it to another folder or library.
func (s *module) updateAsset(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var in struct {
		Title          *string     `json:"title"`
		PlaybackPolicy string      `json:"playback_policy"` // public, or signed: watching needs a signed address
		Description    *string     `json:"description"`
		Tags           *[]string   `json:"tags"`
		Metadata       *[]MetaPair `json:"metadata"`
		target
	}
	if !core.Decode(w, r, &in) {
		return
	}
	details := db.SetAssetDetailsParams{}
	if in.Description != nil {
		d := strings.TrimSpace(*in.Description)
		if utf8.RuneCountInString(d) > core.MaxVideoText {
			core.RespondError(w, r, errInvalidDescription)
			return
		}
		details.Description = pgtype.Text{String: d, Valid: true}
	}
	if in.Tags != nil {
		tags, err := cleanTags(*in.Tags)
		if err != nil {
			core.RespondError(w, r, err)
			return
		}
		details.Tags = tags
	}
	if in.Metadata != nil {
		meta, err := cleanMetadata(*in.Metadata)
		if err != nil {
			core.RespondError(w, r, err)
			return
		}
		raw, err := json.Marshal(meta)
		if err != nil {
			core.InternalError(w, r, err)
			return
		}
		details.Metadata = raw
	}
	if in.Title != nil {
		trimmed := strings.TrimSpace(*in.Title)
		in.Title = &trimmed
		if len([]rune(trimmed)) > 200 {
			core.WriteError(w, http.StatusBadRequest, "invalid_title")
			return
		}
	}
	if in.PlaybackPolicy != "" && !validPolicy(in.PlaybackPolicy) {
		core.WriteError(w, http.StatusBadRequest, "invalid_policy")
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
		if in.Title != nil {
			if _, err := q.SetAssetTitle(r.Context(), db.SetAssetTitleParams{ID: id, Title: *in.Title}); err != nil {
				return err
			}
		}
		if details.Description.Valid || details.Tags != nil || details.Metadata != nil {
			details.ID = id
			if err := q.SetAssetDetails(r.Context(), details); err != nil {
				return err
			}
		}
		if in.PlaybackPolicy != "" {
			if err := q.SetPlaybackPolicy(r.Context(), db.SetPlaybackPolicyParams{ID: id, Policy: in.PlaybackPolicy}); err != nil {
				return err
			}
		}
		if in.LibraryID != "" || in.FolderID != "" {
			if err := moveAssets(r, q, []pgtype.UUID{id}, a.LibraryID, a.FolderID, in.target); err != nil {
				return err
			}
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

// moveAssets puts videos in the target; unnamed parts stay as they were (a new library with no folder means Home).
func moveAssets(r *http.Request, q tx, ids []pgtype.UUID, curLibrary, curFolder pgtype.UUID, t target) error {
	library, folder := curLibrary, curFolder
	if t.LibraryID != "" {
		if library = (pgtype.UUID{}); library.Scan(t.LibraryID) != nil {
			return errInvalidMove
		}
		if library != curLibrary {
			folder = pgtype.UUID{}
		}
	}
	if t.FolderID != "" {
		var err error
		if folder, err = parseTarget(t.FolderID); err != nil {
			return err
		}
	}
	_, err := q.MoveAssets(r.Context(), db.MoveAssetsParams{LibraryID: library, FolderID: folder, Ids: ids})
	return folderError(err)
}

// bulkIDs reads {"ids": [...]} into uuids, refusing none, too many or a malformed one.
func bulkIDs(ids []string) ([]pgtype.UUID, error) {
	if len(ids) == 0 || len(ids) > maxBulk {
		return nil, errInvalidFilter
	}
	out := make([]pgtype.UUID, len(ids))
	for i, s := range ids {
		if out[i].Scan(s) != nil {
			return nil, errNotFound
		}
	}
	return out, nil
}

// bulk runs one action over the videos in the request, all or none.
func (s *module) bulk(act func(r *http.Request, q tx, p core.Principal, ids []pgtype.UUID, in bulkInput) error) func(http.ResponseWriter, *http.Request, core.Principal) {
	return func(w http.ResponseWriter, r *http.Request, p core.Principal) {
		var in bulkInput
		if !p.Can("video:write") {
			core.RespondError(w, r, core.ErrForbidden)
			return
		}
		if !core.Decode(w, r, &in) {
			return
		}
		ids, err := bulkIDs(in.IDs)
		if err == nil {
			err = inScope(r.Context(), s.Pool, p, func(q tx) error { return act(r, q, p, ids, in) })
		}
		if errors.Is(err, pgx.ErrNoRows) {
			err = errNotFound
		}
		if err != nil {
			core.RespondError(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

type bulkInput struct {
	IDs []string `json:"ids"`
	target
}

func (s *module) trashAssets(w http.ResponseWriter, r *http.Request, p core.Principal) {
	s.bulk(func(r *http.Request, q tx, _ core.Principal, ids []pgtype.UUID, _ bulkInput) error {
		_, err := q.TrashAssets(r.Context(), ids)
		return err
	})(w, r, p)
}

func (s *module) restoreAssets(w http.ResponseWriter, r *http.Request, p core.Principal) {
	s.bulk(func(r *http.Request, q tx, _ core.Principal, ids []pgtype.UUID, _ bulkInput) error {
		_, err := q.RestoreAssets(r.Context(), ids)
		return err
	})(w, r, p)
}

// purgeAssets deletes videos for good; only videos already in the trash.
func (s *module) purgeAssets(w http.ResponseWriter, r *http.Request, p core.Principal) {
	s.bulk(func(r *http.Request, q tx, p core.Principal, ids []pgtype.UUID, _ bulkInput) error {
		for _, id := range ids {
			a, err := q.GetAsset(r.Context(), id)
			if err != nil {
				return err
			}
			if !a.DeletedAt.Valid {
				return errNotFound
			}
			if err := purge(r.Context(), s.River, q, id); err != nil {
				return err
			}
		}
		return nil
	})(w, r, p)
}

func (s *module) moveAssetsHandler(w http.ResponseWriter, r *http.Request, p core.Principal) {
	s.bulk(func(r *http.Request, q tx, _ core.Principal, ids []pgtype.UUID, in bulkInput) error {
		if in.LibraryID == "" {
			return errInvalidMove // a bulk move names its library
		}
		return moveAssets(r, q, ids, pgtype.UUID{}, pgtype.UUID{}, in.target)
	})(w, r, p)
}

var errNotRetryable = core.APIError{Status: http.StatusConflict, Code: "asset_not_retryable"}

// retryAsset processes a failed video again from its kept original. A video already processing answers as it is, so a double click is harmless.
func (s *module) retryAsset(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var view AssetView
	err := withPathID(s.Deps, r, p, func(q tx, id pgtype.UUID) error {
		a, err := q.GetAsset(r.Context(), id)
		if err != nil {
			return err
		}
		if a.DeletedAt.Valid {
			return errNotFound
		}
		if a.Status == "waiting" || a.Status == "processing" {
			view, err = LoadAssetView(r.Context(), q, id)
			return err
		}
		// An import that never downloaded, or an upload that never finished, has nothing to process again.
		if _, err := s.Store.S3.HeadObject(r.Context(), &s3.HeadObjectInput{Bucket: &s.Store.Bucket, Key: &a.SourceKey}); err != nil {
			if isMissing(err) {
				return errNotRetryable
			}
			return err
		}
		if _, err := q.RetryAsset(r.Context(), id); errors.Is(err, pgx.ErrNoRows) {
			return errNotRetryable
		} else if err != nil {
			return err
		}
		jobID, err := q.IngestJobID(r.Context(), id)
		if err != nil {
			return err
		}
		if _, err := q.RequeueIngestJob(r.Context(), id); err != nil {
			return err
		}
		if err := transcoder.Restart(r.Context(), s.River, q.TenantTx, AssetRef{TenantID: p.TenantID, AssetID: id, JobID: jobID}); err != nil {
			return err
		}
		view, err = LoadAssetView(r.Context(), q, id)
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusAccepted, view)
}

func isMissing(err error) bool {
	var nf *types.NotFound
	return errors.As(err, &nf)
}
