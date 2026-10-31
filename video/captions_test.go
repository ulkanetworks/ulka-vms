package video

import (
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ulkanetworks/ulka-vms/video/db"
)

func TestToWebVTT(t *testing.T) {
	srt := "\ufeff1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000 align:start\r\nThere\r\n"
	got, err := toWebVTT([]byte(srt))
	if err != nil {
		t.Fatal(err)
	}
	want := "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nHello\n\n2\n00:00:03.000 --> 00:00:04.000 align:start\nThere\n"
	if string(got) != want {
		t.Fatalf("SRT converted to %q", got)
	}
	vtt := "WEBVTT\n\n00:01.000 --> 00:02.000\nKept as is\n"
	if got, err := toWebVTT([]byte(vtt)); err != nil || string(got) != vtt {
		t.Fatalf("WebVTT changed: %q %v", got, err)
	}
	for _, bad := range []string{"", "just text", "1\n00:00:01.000 -> 00:00:02.000\nno arrow"} {
		if _, err := toWebVTT([]byte(bad)); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestWithCaptions(t *testing.T) {
	master := "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n360p.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000\n720p.m3u8\n"
	c := db.ListCaptionsRow{ID: pgtype.UUID{Valid: true}, Language: "en", Name: "English"}
	got := string(withCaptions([]byte(master), []db.ListCaptionsRow{c}, func(db.ListCaptionsRow) string { return "/c.m3u8" }))
	if strings.Count(got, `SUBTITLES="subs"`) != 2 || strings.Count(got, "#EXT-X-MEDIA:TYPE=SUBTITLES") != 1 ||
		strings.Index(got, "#EXT-X-MEDIA") > strings.Index(got, "#EXT-X-STREAM-INF") {
		t.Fatalf("master:\n%s", got)
	}
	if string(withCaptions([]byte(master), nil, nil)) != master {
		t.Fatal("no captions should leave the master as it is")
	}
}
