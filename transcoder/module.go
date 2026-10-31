// Package transcoder turns an uploaded file into a ladder of encrypted HLS renditions: it reads the source, plans the
// ladder, hands the pieces to the nodes that ask for them (the scheduler), joins and packages what they make, and
// reports back. It knows nothing of libraries, folders, playback or billing: whoever submits a video gives it a
// Ref and implements Hooks, and the transcoder never imports them.
package transcoder

import (
	"github.com/riverqueue/river"

	"github.com/ulkanetworks/ulka-vms/core"
)

type module struct {
	*core.Deps
	hooks Hooks
}

// Workers registers the transcoder's River workers; hooks is how it asks and reports (see Hooks).
func Workers(w *river.Workers, d *core.Deps, hooks Hooks) {
	m := &module{Deps: d, hooks: hooks}
	river.AddWorker(w, &probeWorker{module: m})
	river.AddWorker(w, &packageWorker{module: m})
	river.AddWorker(w, &storyboardWorker{module: m})
	river.AddWorker(w, &sweepWorker{module: m})
}
