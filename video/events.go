package video

import (
	"context"
	"encoding/json"
	"math"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/transcoder"
	"github.com/ulkanetworks/ulka-vms/video/db"
)

// AssetView is an asset as the API and webhooks show it: its state, planned renditions, encode progress and playback ids.
type AssetView struct {
	ID              pgtype.UUID        `json:"id"`
	Title           string             `json:"title"`
	LibraryID       pgtype.UUID        `json:"library_id"`
	FolderID        pgtype.UUID        `json:"folder_id"`  // null: directly in Home
	DeletedAt       pgtype.Timestamptz `json:"deleted_at"` // set while the video is in the trash
	Status          string             `json:"status"`
	ErrorCode       pgtype.Text        `json:"error_code"`
	Passthrough     pgtype.Text        `json:"passthrough"`
	InputURL        pgtype.Text        `json:"input_url"` // where it was imported from; null when uploaded
	Download        pgtype.Text        `json:"download"`  // the MP4 download: null (off), preparing, ready or failed
	DurationSeconds pgtype.Float8      `json:"duration_seconds"`
	Width           pgtype.Int4        `json:"width"`
	Height          pgtype.Int4        `json:"height"`
	FrameRate       *float64           `json:"frame_rate"` // frames per second once the video is read; null before
	SizeBytes       *int64             `json:"size_bytes"` // the original file's size once it has been read; null before
	CreatedAt       pgtype.Timestamptz `json:"created_at"`
	UpdatedAt       pgtype.Timestamptz `json:"updated_at"`
	Renditions      []RenditionView    `json:"renditions"`
	Progress        map[string]Count   `json:"progress"`
	PlaybackPolicy  string             `json:"playback_policy"` // public, or signed: watching needs a signed address
	PlaybackURL     string             `json:"playback_url"`    // the HLS playlist on the player host (signed videos need a signature in front)
	EmbedURL        string             `json:"embed_url"`       // the watch page, for links and iframes
	Description     string             `json:"description"`
	Tags            []string           `json:"tags"`
	Metadata        []MetaPair         `json:"metadata"`
	Chapters        []Chapter          `json:"chapters"`
	Poster          PosterView         `json:"poster"`
	Timeline        []Stage            `json:"timeline"` // received, checked, playable, complete: each done, running, waiting or failed
}

type RenditionView struct {
	Name   string `json:"name"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Lane   string `json:"lane"`
}

type Count struct {
	Done    int32   `json:"done"`
	Total   int32   `json:"total"`
	Partial float64 `json:"partial"` // how far the pieces being encoded now have got, in pieces
}

// playerURL is PLAYER_URL, set once when the routes are registered; every view names its addresses there.
var playerURL string

func LoadAssetView(ctx context.Context, q tx, id pgtype.UUID) (AssetView, error) {
	a, err := q.GetAsset(ctx, id)
	if err != nil {
		return AssetView{}, err
	}
	views, err := AssetViews(ctx, q, []db.Asset{a})
	if err != nil {
		return AssetView{}, err
	}
	return views[0], nil
}

// AssetViews builds views for many assets in two queries, however many assets there are.
func AssetViews(ctx context.Context, q tx, assets []db.Asset) ([]AssetView, error) {
	ids := make([]pgtype.UUID, len(assets))
	views := make([]AssetView, len(assets))
	byID := make(map[pgtype.UUID]*AssetView, len(assets))
	for i, a := range assets {
		ids[i] = a.ID
		views[i] = AssetView{
			ID: a.ID, Title: a.Title, LibraryID: a.LibraryID, FolderID: a.FolderID, DeletedAt: a.DeletedAt, Status: a.Status, ErrorCode: a.ErrorCode, Passthrough: a.Passthrough, InputURL: a.InputUrl, Download: a.Download, DurationSeconds: a.DurationSeconds,
			Width: a.Width, Height: a.Height, CreatedAt: a.CreatedAt, UpdatedAt: a.UpdatedAt,
			Renditions:     []RenditionView{},
			Progress:       map[string]Count{"fast": {}, "full": {}, "audio": {}},
			PlaybackPolicy: a.PlaybackPolicy,
			EmbedURL:       playerURL + "/" + a.LibraryID.String() + "/" + a.ID.String(),
			Description:    a.Description, Tags: a.Tags, Metadata: []MetaPair{}, Chapters: []Chapter{},
			Poster: posterView(a),
		}
		var err error
		if views[i].Timeline, err = timelineView(a); err != nil {
			return nil, err
		}
		if views[i].Tags == nil {
			views[i].Tags = []string{}
		}
		if err := json.Unmarshal(a.Metadata, &views[i].Metadata); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(a.Chapters, &views[i].Chapters); err != nil {
			return nil, err
		}
		if src := parseProbe(a.Probe); src != nil && src.SizeBytes > 0 {
			views[i].SizeBytes = &src.SizeBytes
		}
		if a.Plan != nil {
			var p transcoder.Plan
			if err := json.Unmarshal(a.Plan, &p); err != nil {
				return nil, err
			}
			if num, den, ok := strings.Cut(p.FPS, "/"); ok {
				n, _ := strconv.ParseFloat(num, 64)
				d, _ := strconv.ParseFloat(den, 64)
				if n > 0 && d > 0 {
					fps := math.Round(n/d*100) / 100
					views[i].FrameRate = &fps
				}
			}
			for _, r := range p.Rungs {
				views[i].Renditions = append(views[i].Renditions, RenditionView{r.Name, r.Width, r.Height, r.Lane})
			}
		}
		byID[a.ID] = &views[i]
	}
	for i := range views {
		views[i].PlaybackURL = views[i].EmbedURL + "/playlist.m3u8"
	}
	progress, err := transcoder.ProgressOf(ctx, q.TenantTx, ids)
	if err != nil {
		return nil, err
	}
	for _, t := range progress {
		byID[t.AssetID].Progress[t.Lane] = Count{t.Done, t.Total, t.Partial}
	}
	return views, nil
}

func EmitAsset(ctx context.Context, rc *river.Client[pgx.Tx], q tx, typ string, assetID pgtype.UUID) error {
	view, err := LoadAssetView(ctx, q, assetID)
	if err != nil {
		return err
	}
	return core.Emit(ctx, rc, q.TenantTx, typ, view)
}

func EmitJob(ctx context.Context, rc *river.Client[pgx.Tx], q tx, typ string, jobID pgtype.UUID) error {
	job, err := q.GetJob(ctx, jobID)
	if err != nil {
		return err
	}
	return core.Emit(ctx, rc, q.TenantTx, typ, job)
}
