package video

import (
	"github.com/riverqueue/river"

	"github.com/ulkanetworks/ulka-vms/transcoder"
)

// AssetRef identifies the asset a job works on, and the public job it reports to; the transcoder carries it back.
type AssetRef = transcoder.AssetRef

type DeletePrefixArgs struct {
	Prefix string `json:"prefix"`
}

func (DeletePrefixArgs) Kind() string { return "delete_prefix" }

func (DeletePrefixArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: "maintenance", MaxAttempts: 10}
}

type CleanupArgs struct{}

func (CleanupArgs) Kind() string { return "cleanup" }

func (CleanupArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: "maintenance", MaxAttempts: 3}
}
