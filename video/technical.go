package video

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/transcoder"
)

type technical struct {
	Source   *sourceInfo      `json:"source"`
	Plan     *transcoder.Plan `json:"plan"`
	IV       string           `json:"encryption_iv,omitempty"`
	Tasks    []taskInfo       `json:"tasks"`
	Pipeline []pipelineJob    `json:"pipeline"`
	Storage  []storageGroup   `json:"storage"`
	Timeline []Stage          `json:"timeline"`
	// Originals are deleted after 30 days; renditions stay.
	SourceDeletedAt *time.Time `json:"source_deleted_at"`
}

type sourceInfo struct {
	Container   string      `json:"container"`
	SizeBytes   int64       `json:"size_bytes"`
	BitRate     int64       `json:"bit_rate"`
	Video       *streamInfo `json:"video"`
	Audio       *streamInfo `json:"audio"`
	StreamCount int         `json:"stream_count"`
}

type streamInfo struct {
	Codec       string `json:"codec"`
	Profile     string `json:"profile,omitempty"`
	PixelFormat string `json:"pixel_format,omitempty"`
	Width       int    `json:"width,omitempty"`
	Height      int    `json:"height,omitempty"`
	FrameRate   string `json:"frame_rate,omitempty"`
	FieldOrder  string `json:"field_order,omitempty"`
	ColorTrans  string `json:"color_transfer,omitempty"`
	BitRate     int64  `json:"bit_rate,omitempty"`
	Channels    int    `json:"channels,omitempty"`
	Layout      string `json:"channel_layout,omitempty"`
	SampleRate  int    `json:"sample_rate,omitempty"`
}

type taskInfo struct {
	Lane  string `json:"lane"`
	Chunk int32  `json:"chunk"`
	Done  bool   `json:"done"`
	// State is done, running, retrying, queued or failed; Node is the machine running it, or last ran it.
	State    string     `json:"state"`
	Node     string     `json:"node,omitempty"`
	Attempts int32      `json:"attempts"`
	Progress float32    `json:"progress"`
	Error    string     `json:"error,omitempty"`
	Queued   time.Time  `json:"queued_at"`
	Started  *time.Time `json:"started_at"`
	Finished *time.Time `json:"done_at"`
}

type pipelineJob struct {
	ID          int64      `json:"id"`
	Kind        string     `json:"kind"`
	Queue       string     `json:"queue"`
	State       string     `json:"state"`
	Attempt     int        `json:"attempt"`
	MaxAttempts int        `json:"max_attempts"`
	Lane        string     `json:"lane,omitempty"`
	Chunk       *int       `json:"chunk,omitempty"`
	Stage       string     `json:"stage,omitempty"`
	Worker      string     `json:"worker,omitempty"`
	LastError   string     `json:"last_error,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	AttemptedAt *time.Time `json:"attempted_at"`
	FinalizedAt *time.Time `json:"finalized_at"`
}

type storageGroup struct {
	Name    string `json:"name"`
	Objects int    `json:"objects"`
	Bytes   int64  `json:"bytes"`
}

// getTechnical serves GET /v1/assets/{id}/technical: how the video was read, planned, encoded and stored.
func (s *module) getTechnical(w http.ResponseWriter, r *http.Request, p core.Principal) {
	var id pgtype.UUID
	if id.Scan(r.PathValue("id")) != nil {
		core.WriteError(w, http.StatusNotFound, "not_found")
		return
	}
	out, err := technicalOf(r.Context(), s.Deps, p.TenantID, id, func(fn func(tx) error) error { return inScope(r.Context(), s.Pool, p, fn) })
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, out)
}

// technicalOf reads one video's technical view; run opens the transaction it's read in (the caller's scope, or the
// tenant's for Ulka admin). The probe is summarised: its raw form holds a presigned storage link.
func technicalOf(ctx context.Context, d *core.Deps, tenant, id pgtype.UUID, run func(func(tx) error) error) (technical, error) {
	var out technical
	err := run(func(q tx) error {
		row, err := q.GetAssetTechnical(ctx, id)
		if err != nil {
			return err
		}
		out.Source = parseProbe(row.Probe)
		if len(row.Plan) > 0 {
			out.Plan = &transcoder.Plan{}
			if err := json.Unmarshal(row.Plan, out.Plan); err != nil {
				return err
			}
		}
		if len(row.EncryptionIv) > 0 {
			out.IV = hex.EncodeToString(row.EncryptionIv)
		}
		if row.SourceDeletedAt.Valid {
			out.SourceDeletedAt = &row.SourceDeletedAt.Time
		}
		a, err := q.GetAsset(ctx, id)
		if err != nil {
			return err
		}
		if out.Timeline, err = timelineView(a); err != nil {
			return err
		}
		tasks, err := transcoder.Tasks(ctx, q.TenantTx, id)
		if err != nil {
			return err
		}
		out.Tasks = make([]taskInfo, len(tasks))
		for i, t := range tasks {
			out.Tasks[i] = taskInfo{t.Lane, t.Chunk, t.Done, t.State, t.Node, t.Attempts, t.Progress, core.Plain(t.Error), t.Queued, when(t.Started), when(t.Finished)}
		}
		// River's table has no row-level security, so the tenant filter here is the boundary, not RLS.
		rows, err := q.Query(ctx, `SELECT id, kind, queue, state::text, attempt, max_attempts,
				coalesce(args->>'lane', ''), (args->>'chunk')::int, coalesce(args->>'stage', ''),
				coalesce(attempted_by[array_length(attempted_by, 1)], ''),
				coalesce(errors[array_length(errors, 1)]->>'error', ''),
				created_at, attempted_at, finalized_at
			FROM river.river_job WHERE args->>'tenant_id' = $1 AND args->>'asset_id' = $2 ORDER BY id`,
			tenant.String(), id.String())
		if err != nil {
			return err
		}
		defer rows.Close()
		out.Pipeline = []pipelineJob{}
		for rows.Next() {
			var j pipelineJob
			if err := rows.Scan(&j.ID, &j.Kind, &j.Queue, &j.State, &j.Attempt, &j.MaxAttempts, &j.Lane, &j.Chunk, &j.Stage,
				&j.Worker, &j.LastError, &j.CreatedAt, &j.AttemptedAt, &j.FinalizedAt); err != nil {
				return err
			}
			j.LastError = core.Plain(j.LastError)
			out.Pipeline = append(out.Pipeline, j)
		}
		return rows.Err()
	})
	if err != nil {
		return out, err
	}

	// Storage is counted from the bucket itself, grouped by top-level folder (720p, audio, images, source…).
	prefix := tenant.String() + "/" + id.String() + "/"
	groups := map[string]*storageGroup{}
	var order []string
	pages := s3.NewListObjectsV2Paginator(d.Store.S3, &s3.ListObjectsV2Input{Bucket: &d.Store.Bucket, Prefix: &prefix})
	for pages.HasMorePages() {
		page, err := pages.NextPage(ctx)
		if err != nil {
			return out, err
		}
		for _, o := range page.Contents {
			rest := strings.TrimPrefix(*o.Key, prefix)
			name, _, nested := strings.Cut(rest, "/")
			if !nested {
				name = "playlists"
			}
			g, ok := groups[name]
			if !ok {
				g = &storageGroup{Name: name}
				groups[name] = g
				order = append(order, name)
			}
			g.Objects++
			if o.Size != nil {
				g.Bytes += *o.Size
			}
		}
	}
	out.Storage = make([]storageGroup, 0, len(order))
	for _, name := range order {
		out.Storage = append(out.Storage, *groups[name])
	}
	return out, nil
}

func when(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}

// parseProbe keeps the parts of ffprobe's output worth showing; the raw document stays in the database.
func parseProbe(raw []byte) *sourceInfo {
	if len(raw) == 0 {
		return nil
	}
	var p struct {
		Format struct {
			FormatName string `json:"format_long_name"`
			Size       string `json:"size"`
			BitRate    string `json:"bit_rate"`
		} `json:"format"`
		Streams []struct {
			CodecType     string `json:"codec_type"`
			CodecName     string `json:"codec_long_name"`
			Profile       string `json:"profile"`
			PixFmt        string `json:"pix_fmt"`
			Width         int    `json:"width"`
			Height        int    `json:"height"`
			AvgFrameRate  string `json:"avg_frame_rate"`
			FieldOrder    string `json:"field_order"`
			ColorTransfer string `json:"color_transfer"`
			BitRate       string `json:"bit_rate"`
			Channels      int    `json:"channels"`
			ChannelLayout string `json:"channel_layout"`
			SampleRate    string `json:"sample_rate"`
		} `json:"streams"`
	}
	if json.Unmarshal(raw, &p) != nil {
		return nil
	}
	num := func(s string) int64 { n, _ := strconv.ParseInt(s, 10, 64); return n }
	src := &sourceInfo{Container: p.Format.FormatName, SizeBytes: num(p.Format.Size), BitRate: num(p.Format.BitRate), StreamCount: len(p.Streams)}
	for _, st := range p.Streams {
		info := &streamInfo{Codec: st.CodecName, Profile: st.Profile, BitRate: num(st.BitRate)}
		switch {
		case st.CodecType == "video" && src.Video == nil:
			info.PixelFormat, info.Width, info.Height = st.PixFmt, st.Width, st.Height
			info.FrameRate, info.FieldOrder, info.ColorTrans = st.AvgFrameRate, st.FieldOrder, st.ColorTransfer
			src.Video = info
		case st.CodecType == "audio" && src.Audio == nil:
			info.Channels, info.Layout, info.SampleRate = st.Channels, st.ChannelLayout, int(num(st.SampleRate))
			src.Audio = info
		}
	}
	return src
}
