package accounts

import (
	"log/slog"
	"net/http"
	"regexp"

	"github.com/ulkanetworks/ulka-vms/core"
)

var clientRef = regexp.MustCompile(`^[0-9a-f]{8}$`)

// clientError logs a page that broke in someone's browser, so it shows in Health → Logs under the reference the page
// shows them. ponytail: no rate limit; a flood is only log lines, cut to size here; add one if that ever happens.
func (s *module) clientError(w http.ResponseWriter, r *http.Request) {
	var in struct{ Ref, Message, Stack, Path, Build string }
	if !core.Decode(w, r, &in) {
		return
	}
	if !clientRef.MatchString(in.Ref) {
		core.WriteError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	slog.WarnContext(r.Context(), "page crashed ("+in.Ref+"): "+cut(in.Message, 500),
		"path", cut(in.Path, 300), "build", cut(in.Build, 40), "stack", cut(in.Stack, 4000), "browser", cut(r.UserAgent(), 300))
	w.WriteHeader(http.StatusNoContent)
}

func cut(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}
