package video

import (
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ulkanetworks/ulka-vms/video/db"
)

func TestSegmentBase(t *testing.T) {
	const origin = "https://origin.ulka.example/s"
	text := func(s string) pgtype.Text { return pgtype.Text{String: s, Valid: true} }
	live := &Distribution{Hostname: "abc123defg.ulkacdn.test", Active: true}
	for name, c := range map[string]struct {
		d    delivery
		want string
	}{
		"origin":                           {delivery{GetVideoDeliveryRow: db.GetVideoDeliveryRow{Mode: modeOrigin}}, origin},
		"own CDN keeps the path":           {delivery{GetVideoDeliveryRow: db.GetVideoDeliveryRow{Mode: modeCustom, CustomUrl: text("https://cdn.customer.test")}}, "https://cdn.customer.test/s"},
		"managed CDN once live":            {delivery{db.GetVideoDeliveryRow{Mode: modeManaged}, live}, "https://abc123defg.ulkacdn.test/s"},
		"managed CDN still deploying":      {delivery{db.GetVideoDeliveryRow{Mode: modeManaged}, &Distribution{Hostname: "abc123defg.ulkacdn.test"}}, origin},
		"managed distribution was deleted": {delivery{GetVideoDeliveryRow: db.GetVideoDeliveryRow{Mode: modeManaged}}, origin},
	} {
		if got := segmentBase(origin, c.d); got != c.want {
			t.Errorf("%s: got %s, want %s", name, got, c.want)
		}
	}
}

func TestImageDemuxer(t *testing.T) {
	for name, c := range map[string]struct {
		head string
		want string
	}{
		"jpeg":     {"\xFF\xD8\xFF\xE0", "jpeg_pipe"},
		"png":      {"\x89PNG\r\n\x1a\n", "png_pipe"},
		"gif":      {"GIF89a", "gif"},
		"webp":     {"RIFF\x00\x00\x00\x00WEBPVP8 ", "webp_pipe"},
		"wav":      {"RIFF\x00\x00\x00\x00WAVEfmt ", ""},
		"playlist": {"#EXTM3U\n", ""},
		"empty":    {"", ""},
	} {
		if got := imageDemuxer([]byte(c.head)); got != c.want {
			t.Errorf("%s: got %q, want %q", name, got, c.want)
		}
	}
}
