package video

import (
	"encoding/json"
	"time"

	"github.com/ulkanetworks/ulka-vms/video/db"
)

// stages are a video's processing steps in order; times come from assets.timeline, set as each happens.
var stages = []string{"received", "checked", "playable", "complete"}

// Stage is one step of a video's processing: done (with when, if known), running, waiting, or failed.
type Stage struct {
	Stage string     `json:"stage"`
	State string     `json:"state"`
	At    *time.Time `json:"at"`
}

// timelineView decides each stage's state from the times recorded and the video's status, so videos processed
// before times were kept still show what is done.
func timelineView(a db.Asset) ([]Stage, error) {
	at := map[string]time.Time{}
	if len(a.Timeline) > 0 {
		if err := json.Unmarshal(a.Timeline, &at); err != nil {
			return nil, err
		}
	}
	// How far the status alone says it got: 0 nothing, 2 checked (planned), 3 playable, 4 complete.
	reached := map[string]int{"ready": 3, "complete": 4}[a.Status]
	if a.Plan != nil && reached < 2 {
		reached = 2
	}
	out := make([]Stage, len(stages))
	current := true // the first stage not done yet is the one running (or failed)
	for i, name := range stages {
		s := Stage{Stage: name, State: "waiting"}
		if t, ok := at[name]; ok {
			s.At = &t
		}
		switch {
		case s.At != nil || i < reached || (name == "received" && a.Status != "waiting"):
			s.State = "done"
		case current && a.Status == "errored":
			s.State, current = "failed", false
			if t, ok := at["failed"]; ok {
				s.At = &t
			}
		case current && a.Status != "waiting":
			s.State, current = "running", false
		default:
			current = false
		}
		out[i] = s
	}
	return out, nil
}
