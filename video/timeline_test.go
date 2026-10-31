package video

import (
	"strings"
	"testing"

	"github.com/ulkanetworks/ulka-vms/video/db"
)

func TestTimelineView(t *testing.T) {
	states := func(a db.Asset) string {
		v, err := timelineView(a)
		if err != nil {
			t.Fatal(err)
		}
		var s []string
		for _, x := range v {
			s = append(s, x.State)
		}
		return strings.Join(s, " ")
	}
	at := []byte(`{"received":"2026-10-05T12:03:00Z","checked":"2026-10-05T12:03:05Z"}`)
	for want, a := range map[string]db.Asset{
		"waiting waiting waiting waiting": {Status: "waiting"},
		"done running waiting waiting":    {Status: "processing"},
		"done done running waiting":       {Status: "processing", Timeline: at},
		"done done done running":          {Status: "ready", Timeline: at},
		"done done done done":             {Status: "complete"}, // before times were kept
		"done failed waiting waiting":     {Status: "errored", Timeline: []byte(`{"received":"2026-10-05T12:03:00Z","failed":"2026-10-05T12:04:00Z"}`)},
	} {
		if got := states(a); got != want {
			t.Errorf("%s %s: got %q, want %q", a.Status, a.Timeline, got, want)
		}
	}
	v, _ := timelineView(db.Asset{Status: "errored", Timeline: []byte(`{"received":"2026-10-05T12:03:00Z","failed":"2026-10-05T12:04:00Z"}`)})
	if v[1].At == nil || v[1].At.Minute() != 4 {
		t.Fatalf("a failed stage carries when it failed: %+v", v[1])
	}
}
