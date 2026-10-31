package video

import (
	"context"
	"encoding/json"
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
	"github.com/ulkanetworks/ulka-vms/transcoder"
	"github.com/ulkanetworks/ulka-vms/video/db"
)

const maxUploadBytes = 50 << 30

// apiError is an expected failure with a stable code for the client.
var (
	errNotFound        = core.APIError{Status: http.StatusNotFound, Code: "not_found"}
	errUploadNotFound  = core.APIError{Status: http.StatusNotFound, Code: "upload_not_found"}
	errUploadUsed      = core.APIError{Status: http.StatusConflict, Code: "upload_already_used"}
	errInvalidFilter   = core.APIError{Status: http.StatusBadRequest, Code: "invalid_filter"}
	errInvalidInputURL = core.APIError{Status: http.StatusBadRequest, Code: "invalid_input_url"}
	errInvalidSource   = core.APIError{Status: http.StatusBadRequest, Code: "invalid_source"}
)

// completeUpload marks a fully received upload and starts the video's processing, whichever way the bytes arrived.
func (s *module) completeUpload(ctx context.Context, tenantID, assetID pgtype.UUID) error {
	return inTenant(ctx, s.Pool, tenantID, func(q tx) error {
		uploadID, err := q.CompleteUpload(ctx, assetID)
		if err != nil {
			return err
		}
		if err := core.Emit(ctx, s.River, q.TenantTx, "upload.completed", map[string]any{"id": uploadID, "asset_id": assetID}); err != nil {
			return err
		}
		return s.startIngest(ctx, q, tenantID, assetID)
	})
}

// startIngest enqueues the probe once both the asset and its finished upload exist; whichever arrives second triggers it.
func (s *module) startIngest(ctx context.Context, q tx, tenantID, assetID pgtype.UUID) error {
	if _, err := q.StartAssetIfWaiting(ctx, assetID); errors.Is(err, pgx.ErrNoRows) {
		return nil
	} else if err != nil {
		return err
	}
	jobID, err := q.IngestJobID(ctx, assetID)
	if err != nil {
		return err
	}
	return transcoder.Start(ctx, s.River, q.TenantTx, AssetRef{TenantID: tenantID, AssetID: assetID, JobID: jobID})
}

func (s *module) createUpload(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var up db.CreateUploadRow
	var limits core.Limits
	err := inTenant(r.Context(), s.Pool, p.TenantID, func(q tx) (err error) {
		if limits, err = core.LimitsFor(r.Context(), q.TenantTx); err != nil {
			return err
		}
		up, err = q.CreateUpload(r.Context())
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusCreated, map[string]any{
		"id": up.ID, "status": up.Status, "expires_at": up.ExpiresAt,
		"upload_url": s.PublicURL + "/v1/uploads/" + up.ID.String(), "max_size": limits.MaxUploadBytes, // what putUpload enforces
	})
}

// createAsset makes a video from a finished (or still running) upload, or from input_url, which a worker fetches.
func (s *module) createAsset(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var in struct {
		UploadID       string  `json:"upload_id"`
		InputURL       string  `json:"input_url"`
		Passthrough    *string `json:"passthrough"`
		PlaybackPolicy string  `json:"playback_policy"`
		Download       *bool   `json:"download"` // also make an MP4 download once it's processed; absent follows the library
		Title          string  `json:"title"`
		LibraryID      string  `json:"library_id"` // absent: the workspace's default library
		FolderID       string  `json:"folder_id"`  // absent or "root": Home
	}
	if !core.Decode(w, r, &in) {
		return
	}
	if in.PlaybackPolicy != "" && !validPolicy(in.PlaybackPolicy) {
		core.WriteError(w, http.StatusBadRequest, "invalid_policy")
		return
	}
	in.Title = strings.TrimSpace(in.Title)
	if len([]rune(in.Title)) > 200 {
		core.WriteError(w, http.StatusBadRequest, "invalid_title")
		return
	}
	passthrough := pgtype.Text{Valid: in.Passthrough != nil}
	if passthrough.Valid {
		if passthrough.String = *in.Passthrough; utf8.RuneCountInString(passthrough.String) > core.MaxReference {
			core.WriteError(w, http.StatusBadRequest, "invalid_passthrough")
			return
		}
	}
	var uploadID pgtype.UUID
	importing := in.InputURL != ""
	switch {
	case importing == (in.UploadID != ""):
		core.RespondError(w, r, errInvalidSource) // exactly one of upload_id and input_url
		return
	case importing:
		if !validInputURL(in.InputURL) {
			core.RespondError(w, r, errInvalidInputURL)
			return
		}
	case uploadID.Scan(in.UploadID) != nil:
		core.WriteError(w, http.StatusNotFound, "upload_not_found")
		return
	}

	var asset AssetView
	err := inTenant(r.Context(), s.Pool, p.TenantID, func(q tx) error {
		params := db.CreateAssetParams{Status: "waiting", Passthrough: passthrough, Title: in.Title, PlaybackPolicy: in.PlaybackPolicy} // empty: the library's default
		var err error
		if in.LibraryID == "" {
			params.LibraryID, err = q.EnsureDefaultLibrary(r.Context())
		} else if params.LibraryID.Scan(in.LibraryID) != nil {
			err = errNotFound
		}
		if err != nil {
			return err
		}
		if params.FolderID, err = parseTarget(in.FolderID); err != nil {
			return err
		}
		libDefaults, err := q.LibraryDefaults(r.Context(), params.LibraryID)
		if errors.Is(err, pgx.ErrNoRows) {
			return errNotFound // a library of another workspace looks the same as none
		}
		if err != nil {
			return err
		}
		download := libDefaults.Mp4Downloads
		if in.Download != nil {
			download = *in.Download
		}
		complete := false
		if importing {
			params.ID, params.InputUrl = newAssetID(), pgtype.Text{String: in.InputURL, Valid: true}
		} else {
			up, err := q.LockUpload(r.Context(), uploadID)
			// An expired upload can never finish, so a video made from it would wait forever.
			if errors.Is(err, pgx.ErrNoRows) || up.Status == "expired" || (up.Status != "complete" && up.ExpiresAt.Time.Before(time.Now())) {
				return errUploadNotFound
			}
			if err != nil {
				return err
			}
			params.ID, params.UploadID, complete = up.AssetID, uploadID, up.Status == "complete"
		}
		params.SourceKey = SourceKey(p.TenantID, params.ID)
		_, err = q.CreateAsset(r.Context(), params)
		if pgErr := (*pgconn.PgError)(nil); errors.As(err, &pgErr) {
			switch pgErr.Code {
			case "23505":
				return errUploadUsed
			case "23503":
				return errNotFound // a folder that isn't in that library
			}
		}
		if err != nil {
			return err
		}
		jobType := "ingest"
		if importing {
			jobType = "import"
		}
		jobID, err := q.CreateJob(r.Context(), db.CreateJobParams{AssetID: params.ID, Type: jobType})
		if err != nil {
			return err
		}
		if download {
			if _, err := q.SetAssetDownload(r.Context(), db.SetAssetDownloadParams{ID: params.ID, Download: pgtype.Text{String: "preparing", Valid: true}}); err != nil {
				return err
			}
		}
		switch {
		case importing:
			ref := AssetRef{TenantID: p.TenantID, AssetID: params.ID, JobID: jobID}
			if _, err := s.River.InsertTx(r.Context(), q.Tx, FetchArgs{AssetRef: ref, URL: in.InputURL}, nil); err != nil {
				return err
			}
		case complete:
			if err := s.startIngest(r.Context(), q, p.TenantID, params.ID); err != nil {
				return err
			}
		}
		if asset, err = LoadAssetView(r.Context(), q, params.ID); err != nil {
			return err
		}
		return core.Emit(r.Context(), s.River, q.TenantTx, "asset.created", asset)
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusCreated, asset)
}

func (s *module) getAsset(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var asset AssetView
	err := withPathID(s.Deps, r, p, func(q tx, id pgtype.UUID) (err error) {
		asset, err = LoadAssetView(r.Context(), q, id)
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, asset)
}

// listAssets pages videos by cursor, newest first: ?q= searches the title, reference and id; ?status=, ?library_id=,
// ?folder_id= (a folder, or "root" for Home), ?policy=public|signed (signed: private, no public link) and ?trashed=true filter; ?sort=oldest reverses the order.
func (s *module) listAssets(w http.ResponseWriter, r *http.Request, p core.Principal) {
	c, err := core.ParseCursor(r)
	status := r.URL.Query().Get("status")
	for _, st := range strings.Split(status, ",") {
		if status != "" && !slices.Contains([]string{"waiting", "processing", "ready", "complete", "errored"}, st) {
			err = errInvalidFilter
		}
	}
	var after, library, folder pgtype.UUID
	if err == nil {
		after, err = c.AfterUUID()
	}
	v := r.URL.Query()
	folderMode := "any"
	if err == nil && v.Get("library_id") != "" && library.Scan(v.Get("library_id")) != nil {
		err = errInvalidFilter
	}
	if err == nil && v.Get("folder_id") != "" {
		if folderMode = "root"; v.Get("folder_id") != "root" {
			folderMode = "folder"
			if folder.Scan(v.Get("folder_id")) != nil {
				err = errInvalidFilter
			}
		}
	}
	trashed := v.Get("trashed") == "true"
	policy := v.Get("policy")
	if err == nil && policy != "" && !validPolicy(policy) {
		err = errInvalidFilter
	}
	// ?tag= and ?metadata_key=&metadata_value= find videos by their labels, e.g. an app's own id kept in metadata.
	tag, meta := v.Get("tag"), []byte("[]")
	if k := v.Get("metadata_key"); err == nil && k != "" {
		meta, err = json.Marshal([]MetaPair{{k, v.Get("metadata_value")}})
	}
	sort := v.Get("sort")
	if err == nil && sort != "" && sort != "newest" && sort != "oldest" {
		err = errInvalidFilter
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	var assets []AssetView
	var total int64
	err = inTenant(r.Context(), s.Pool, p.TenantID, func(q tx) error {
		params := db.ListAssetsParams{Status: status, Pattern: c.Like(),
			AfterAt: c.At, AfterID: after, Lim: c.Fetch(), LibraryID: library, FolderMode: folderMode, FolderID: folder, Trashed: trashed, Policy: policy, Tag: tag, Meta: meta}
		list := q.ListAssets
		if sort == "oldest" {
			list = func(ctx context.Context, p db.ListAssetsParams) ([]db.Asset, error) {
				return q.ListAssetsOldest(ctx, db.ListAssetsOldestParams(p))
			}
		}
		rows, err := list(r.Context(), params)
		if err != nil {
			return err
		}
		if assets, err = AssetViews(r.Context(), q, rows); err != nil {
			return err
		}
		total, err = q.CountAssets(r.Context(), db.CountAssetsParams{Status: status, Pattern: c.Like(), LibraryID: library, FolderMode: folderMode, FolderID: folder, Trashed: trashed, Policy: policy, Tag: tag, Meta: meta})
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, core.PagedTotal(assets, c, func(a AssetView) (time.Time, string) { return a.CreatedAt.Time, a.ID.String() }, total))
}

func (s *module) listAssetJobs(w http.ResponseWriter, r *http.Request, p core.Principal) {
	jobs := []db.ListAssetJobsRow{}
	err := withPathID(s.Deps, r, p, func(q tx, id pgtype.UUID) error {
		if _, err := q.GetAsset(r.Context(), id); err != nil {
			return err
		}
		rows, err := q.ListAssetJobs(r.Context(), id)
		jobs = append(jobs, rows...)
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, map[string]any{"data": jobs})
}

func (s *module) getJob(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var job db.GetJobRow
	err := withPathID(s.Deps, r, p, func(q tx, id pgtype.UUID) (err error) {
		job, err = q.GetJob(r.Context(), id)
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, job)
}

// withPathID parses {id} and runs fn in the caller's tenant; a malformed id is a 404 like any other miss.
