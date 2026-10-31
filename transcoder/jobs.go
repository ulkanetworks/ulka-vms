package transcoder

import "github.com/riverqueue/river"

type ProbeArgs struct{ AssetRef }

func (ProbeArgs) Kind() string { return "probe" }

func (ProbeArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: "interactive", MaxAttempts: 6}
}

type PackageArgs struct {
	AssetRef
	Stage string `json:"stage"` // "ready": fast rungs only; "complete": the full ladder
}

func (PackageArgs) Kind() string { return "package" }

func (PackageArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: "interactive", MaxAttempts: 6}
}

type StoryboardArgs struct{ AssetRef }

func (StoryboardArgs) Kind() string { return "storyboard" }

func (StoryboardArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: "standard", MaxAttempts: 3}
}

// SweepArgs fails the videos whose encode tasks have run out of tries (see sweepWorker).
type SweepArgs struct{}

func (SweepArgs) Kind() string { return "encode_sweep" }

func (SweepArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: "maintenance", MaxAttempts: 1}
}
