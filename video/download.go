package video

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	awshttp "github.com/aws/aws-sdk-go-v2/aws/transport/http"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/transcoder"
	"github.com/ulkanetworks/ulka-vms/video/db"
)

var (
	errAssetFailed      = core.APIError{Status: http.StatusConflict, Code: "asset_failed"}
	errDownloadNotReady = core.APIError{Status: http.StatusNotFound, Code: "download_not_ready"}
)

// MakeDownloadArgs builds a video's MP4 download from its published HLS: the top rendition and the audio,
// decrypted and joined without encoding again. The encoded chunks are gone by then, so this works the same
// whether the download was asked for at upload or long after.
type MakeDownloadArgs struct {
	TenantID pgtype.UUID `json:"tenant_id"`
	AssetID  pgtype.UUID `json:"asset_id"`
}

func (MakeDownloadArgs) Kind() string { return "make_download" }

func (MakeDownloadArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: "standard", MaxAttempts: 3}
}

type downloadWorker struct {
	river.WorkerDefaults[MakeDownloadArgs]
	*module
}

func (w *downloadWorker) Work(ctx context.Context, job *river.Job[MakeDownloadArgs]) error {
	ref := AssetRef{TenantID: job.Args.TenantID, AssetID: job.Args.AssetID}
	err := w.make(ctx, ref)
	if errors.Is(err, pgx.ErrNoRows) {
		return river.JobCancel(err) // the video was deleted
	}
	status, event := "ready", "asset.download_ready"
	if err != nil {
		if job.Attempt < job.MaxAttempts {
			return err
		}
		slog.Error("download gave up", "asset", ref.AssetID, "err", err)
		status, event = "failed", "asset.download_failed"
	}
	return inTenant(ctx, w.Pool, ref.TenantID, func(q tx) error {
		n, err := q.FinishAssetDownload(ctx, db.FinishAssetDownloadParams{ID: ref.AssetID, Download: pgtype.Text{String: status, Valid: true}})
		if err != nil {
			return err
		}
		if n == 0 { // turned off while it was being made
			return w.removeFile(ctx, ref.TenantID, ref.AssetID)
		}
		return EmitAsset(ctx, river.ClientFromContext[pgx.Tx](ctx), q, event, ref.AssetID)
	})
}

func (w *downloadWorker) make(ctx context.Context, ref AssetRef) error {
	work, p, err := w.loadWork(ctx, ref)
	if err != nil {
		return err
	}
	if len(p.Rungs) == 0 {
		return errors.New("no renditions")
	}
	top := p.Rungs[0]
	for _, r := range p.Rungs {
		if r.Height > top.Height {
			top = r
		}
	}
	dir, err := os.MkdirTemp("", "download")
	if err != nil {
		return err
	}
	defer core.RemoveTemp(dir)
	prefix := ref.TenantID.String() + "/" + ref.AssetID.String() + "/"
	video, err := w.track(ctx, dir, prefix, top.Name, work.Key, work.IV)
	if err != nil {
		return err
	}
	args := []string{"-i", video}
	maps := []string{"-map", "0:v"}
	if p.Audio {
		audio, err := w.track(ctx, dir, prefix, "audio", work.Key, work.IV)
		if err != nil {
			return err
		}
		args, maps = append(args, "-i", audio), append(maps, "-map", "1:a")
	}
	out := filepath.Join(dir, "download.mp4")
	// faststart puts the index first, so a download starts playing before it has finished arriving.
	if err := transcoder.Ffmpeg(ctx, append(append(args, maps...), "-c", "copy", "-movflags", "+faststart", out)...); err != nil {
		return err
	}
	return w.Store.PutFile(ctx, prefix+"download.mp4", out)
}

var mapURI = regexp.MustCompile(`URI="([^"]+)"`)

// track joins one rendition's init segment and its decrypted media segments into a single fragmented MP4.
func (w *downloadWorker) track(ctx context.Context, dir, prefix, name string, key, iv []byte) (string, error) {
	playlist, err := w.Store.ReadObject(ctx, prefix+name+".m3u8")
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, name+".mp4")
	f, err := os.Create(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	for _, line := range strings.Split(string(playlist), "\n") {
		line = strings.TrimSpace(line)
		var data []byte
		switch {
		case strings.HasPrefix(line, "#EXT-X-MAP:"):
			m := mapURI.FindStringSubmatch(line)
			if m == nil {
				return "", errors.New(name + ": init segment without a URI")
			}
			if data, err = w.Store.ReadObject(ctx, prefix+m[1]); err != nil {
				return "", err
			}
		case line == "" || strings.HasPrefix(line, "#"):
			continue
		default:
			enc, err := w.Store.ReadObject(ctx, prefix+line)
			if err != nil {
				return "", err
			}
			if data, err = transcoder.DecryptSegment(enc, key, iv); err != nil {
				return "", err
			}
		}
		if _, err := f.Write(data); err != nil {
			return "", err
		}
	}
	return path, f.Close()
}

func (s *module) removeFile(ctx context.Context, tenantID, assetID pgtype.UUID) error {
	key := tenantID.String() + "/" + assetID.String() + "/download.mp4"
	_, err := s.Store.S3.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &s.Store.Bucket, Key: &key})
	return err
}

// requestDownload asks for an MP4 copy: made now for a finished video, or as soon as it finishes.
func (s *module) requestDownload(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var out AssetView
	err := withPathID(s.Deps, r, p, func(q tx, id pgtype.UUID) error {
		a, err := q.GetAsset(r.Context(), id)
		if err != nil {
			return err
		}
		if a.Status == "errored" {
			return errAssetFailed
		}
		if !a.Download.Valid || a.Download.String == "failed" { // already preparing or ready: nothing to do
			if _, err := q.SetAssetDownload(r.Context(), db.SetAssetDownloadParams{ID: id, Download: pgtype.Text{String: "preparing", Valid: true}}); err != nil {
				return err
			}
			if a.Status == "complete" {
				if _, err := s.River.InsertTx(r.Context(), q.Tx, MakeDownloadArgs{p.TenantID, id}, nil); err != nil {
					return err
				}
			}
		}
		out, err = LoadAssetView(r.Context(), q, id)
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusAccepted, out)
}

// removeDownload turns the download off and deletes the file; playback is untouched.
func (s *module) removeDownload(w http.ResponseWriter, r *http.Request, p core.Principal) {
	err := withPathID(s.Deps, r, p, func(q tx, id pgtype.UUID) error {
		n, err := q.SetAssetDownload(r.Context(), db.SetAssetDownloadParams{ID: id})
		if err == nil && n == 0 {
			return pgx.ErrNoRows
		}
		if err != nil {
			return err
		}
		return s.removeFile(r.Context(), p.TenantID, id)
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

var unsafeFilename = regexp.MustCompile(`[^A-Za-z0-9 ._-]+`)

// serveDownload checks access exactly as playback does, then streams the file from storage, so the bytes are
// counted: each download is appended to the origin's access log in ClickHouse, where segments are metered.
// ponytail: the file passes through the API (one copy loop per download); a presigned link would skip the API but
// can't be metered. Move to the origin once downloads are a real share of traffic.
func (s *module) serveDownload(w http.ResponseWriter, r *http.Request, p playback) {
	if p.download != "ready" {
		core.RespondError(w, r, errDownloadNotReady)
		return
	}
	name := strings.TrimSpace(unsafeFilename.ReplaceAllString(p.name, ""))
	if name == "" {
		name = p.assetID.String()
	}
	key := p.prefix() + "download.mp4"
	in := &s3.GetObjectInput{Bucket: &s.Store.Bucket, Key: &key}
	if rg := r.Header.Get("Range"); rg != "" {
		in.Range = &rg
	}
	obj, err := s.Store.S3.GetObject(r.Context(), in)
	if err != nil {
		var re *awshttp.ResponseError
		if errors.As(err, &re) && re.HTTPStatusCode() == http.StatusRequestedRangeNotSatisfiable {
			w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
			return
		}
		core.InternalError(w, r, err)
		return
	}
	defer obj.Body.Close()
	h := w.Header()
	h.Set("Content-Type", "video/mp4")
	h.Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name + ".mp4"}))
	h.Set("Accept-Ranges", "bytes")
	h.Set("Cache-Control", "private, no-store")
	if obj.ContentLength != nil {
		h.Set("Content-Length", strconv.FormatInt(*obj.ContentLength, 10))
	}
	status := http.StatusOK
	if obj.ContentRange != nil {
		h.Set("Content-Range", *obj.ContentRange)
		status = http.StatusPartialContent
	}
	w.WriteHeader(status)
	start := time.Now()
	n, _ := io.Copy(w, obj.Body) // a viewer who stops the download is not an error; what was sent still counts
	s.logDelivery(r, p, status, n, time.Since(start))
}

// logDelivery adds the download as one line of origin_access_logs (deploy/clickhouse/20-video-delivery.sql), the
// same shape the origin's Vector ships, so video_delivery_hourly and Usage count it with the segments.
func (s *module) logDelivery(r *http.Request, p playback, status int, sent int64, took time.Duration) {
	s.deliveries.Add(map[string]any{
		"ts": time.Now().UTC().Format(time.DateTime), "client_addr": core.ClientIP(r, s.TrustedProxies).String(),
		"method": r.Method, "uri": "/s/" + p.tenantID.String() + "/" + p.assetID.String() + "/download.mp4",
		"status": status, "body_bytes": sent, "request_time": took.Seconds(), "user_agent": r.UserAgent(), "referer": r.Referer(),
	})
}
