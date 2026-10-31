package video

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	tusd "github.com/tus/tusd/v2/pkg/handler"
	"github.com/tus/tusd/v2/pkg/s3store"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/video/db"
)

// Sending a file is Ulka's own protocol on upload_url, so any HTTP client can do it. PUT the whole file, or PUT it in
// pieces, in order, each with Content-Range: bytes START-END/TOTAL; GET says how much has arrived, so a broken
// transfer carries on from there. The id is the permission (no API key, so a browser can do it). The bytes become one
// S3 multipart upload (tusd's s3store, used only as storage).

var (
	errContentRange   = core.APIError{Status: http.StatusBadRequest, Code: "invalid_content_range"}
	errOffsetMismatch = core.APIError{Status: http.StatusConflict, Code: "upload_offset_mismatch"}
	errUploadBusy     = core.APIError{Status: http.StatusConflict, Code: "upload_busy"}
	errUploadTooLarge = core.APIError{Status: http.StatusRequestEntityTooLarge, Code: "upload_too_large"}
	errLengthRequired = core.APIError{Status: http.StatusLengthRequired, Code: "upload_length_required"}
	errIncomplete     = core.APIError{Status: http.StatusBadRequest, Code: "upload_incomplete"}
)

// lockWait is how long a piece waits for the one before it; that one is asked to stop meanwhile, since its client
// has given up on it.
const lockWait = 10 * time.Second

type uploadView struct {
	Received int64  `json:"received"`
	Size     *int64 `json:"size"` // null until the first piece names it
	Complete bool   `json:"complete"`
}

// uploadCORS lets a browser on another website send a file straight to its upload address.
func uploadCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Content-Range")
	w.Header().Set("Access-Control-Max-Age", "86400")
}

func (s *module) uploadPreflight(w http.ResponseWriter, _ *http.Request) {
	uploadCORS(w)
	w.WriteHeader(http.StatusNoContent)
}

func (s *module) storage() s3store.S3Store { return s3store.New(s.Store.Bucket, s.Store.S3) }

// uploadState finds an upload by the id in its address.
func (s *module) uploadState(ctx context.Context, r *http.Request) (pgtype.UUID, db.UploadStateRow, error) {
	var id pgtype.UUID
	if id.Scan(r.PathValue("id")) != nil {
		return id, db.UploadStateRow{}, errUploadNotFound
	}
	st, err := db.New(s.Pool).UploadState(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return id, st, errUploadNotFound
	}
	return id, st, err
}

// received is how much of an upload storage holds.
func (s *module) received(ctx context.Context, st db.UploadStateRow) (uploadView, error) {
	switch {
	case st.Status == "complete":
		return uploadView{Received: st.Size, Size: &st.Size, Complete: true}, nil
	case st.StoreID == "":
		return uploadView{}, nil
	}
	info, err := s.storeInfo(ctx, st.StoreID)
	if err != nil {
		return uploadView{}, err
	}
	return uploadView{Received: info.Offset, Size: &st.Size}, nil
}

func (s *module) storeInfo(ctx context.Context, storeID string) (tusd.FileInfo, error) {
	up, err := s.storage().GetUpload(ctx, storeID)
	if err != nil {
		return tusd.FileInfo{}, err
	}
	return up.GetInfo(ctx)
}

// uploadStatus answers GET upload_url: how much has arrived, so a client knows where to carry on.
func (s *module) uploadStatus(w http.ResponseWriter, r *http.Request) {
	uploadCORS(w)
	_, st, err := s.uploadState(r.Context(), r)
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	v, err := s.received(r.Context(), st)
	if err != nil {
		core.InternalError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, v)
}

// putUpload takes the whole file, or one piece of it (Content-Range). A piece starting at 0 starts the upload over;
// any other must start where the last one stopped. The last byte starts the video's processing.
func (s *module) putUpload(w http.ResponseWriter, r *http.Request) {
	uploadCORS(w)
	ctx, stop := context.WithCancel(r.Context())
	defer stop()
	id, st, err := s.uploadState(ctx, r)
	if err == nil && st.Status == "complete" {
		err = errUploadUsed
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	length := r.ContentLength
	if length <= 0 {
		core.RespondError(w, r, errLengthRequired)
		return
	}
	start, total := int64(0), length
	if cr := r.Header.Get("Content-Range"); cr != "" {
		var end int64
		if n, _ := fmt.Sscanf(cr, "bytes %d-%d/%d", &start, &end, &total); n != 3 || start < 0 || end < start || end >= total || end-start+1 != length {
			core.RespondError(w, r, errContentRange)
			return
		}
	}
	var limits core.Limits
	if err := inTenant(ctx, s.Pool, st.TenantID, func(q tx) (err error) {
		limits, err = core.LimitsFor(ctx, q.TenantTx)
		return err
	}); err != nil {
		core.InternalError(w, r, err)
		return
	}
	if total > min(limits.MaxUploadBytes, maxUploadBytes) {
		core.RespondError(w, r, errUploadTooLarge)
		return
	}

	lock := uploadLock(s.Pool, id.String())
	waitCtx, cancel := context.WithTimeout(ctx, lockWait)
	err = lock.Lock(waitCtx, stop)
	cancel()
	if errors.Is(err, errLockTimeout) {
		core.RespondError(w, r, errUploadBusy)
		return
	} else if err != nil {
		core.InternalError(w, r, err)
		return
	}
	defer func() {
		if err := lock.Unlock(); err != nil {
			slog.ErrorContext(ctx, "upload unlock failed", "err", err)
		}
	}()
	// The piece before may have finished while this one waited.
	if _, st, err = s.uploadState(ctx, r); err == nil && st.Status == "complete" {
		err = errUploadUsed
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}

	var up tusd.Upload
	if start == 0 {
		up, err = s.storage().NewUpload(ctx, tusd.FileInfo{ID: SourceKey(st.TenantID, st.AssetID), Size: total, MetaData: tusd.MetaData{}})
		var info tusd.FileInfo
		if err == nil {
			info, err = up.GetInfo(ctx)
		}
		if err == nil {
			_, err = db.New(s.Pool).UploadBegin(ctx, db.UploadBeginParams{ID: id, StoreID: info.ID, Size: total})
		}
		if errors.Is(err, pgx.ErrNoRows) {
			err = errUploadUsed
		}
	} else {
		var info tusd.FileInfo
		if st.StoreID == "" || st.Size != total {
			err = errOffsetMismatch
		} else if up, err = s.storage().GetUpload(ctx, st.StoreID); err == nil {
			if info, err = up.GetInfo(ctx); err == nil && info.Offset != start {
				err = errOffsetMismatch
			}
		}
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	n, err := up.WriteChunk(ctx, start, http.MaxBytesReader(w, r.Body, length))
	if err != nil || n != length {
		if err != nil {
			slog.WarnContext(ctx, "upload piece broke", "err", err) // what arrived is kept; GET says how much
		}
		core.RespondError(w, r, errIncomplete)
		return
	}
	v := uploadView{Received: start + n, Size: &total}
	if v.Received == total {
		if err := up.FinishUpload(ctx); err != nil {
			core.InternalError(w, r, err)
			return
		}
		if err := s.completeUpload(ctx, st.TenantID, st.AssetID); err != nil {
			core.InternalError(w, r, err)
			return
		}
		v.Complete = true
	}
	core.WriteJSON(w, http.StatusOK, v)
}
