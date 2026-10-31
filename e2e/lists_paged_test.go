package e2e

import (
	"net/http"
	"strings"
	"testing"
)

// pagedNames reads a list three rows at a time and returns the field of every row, in order; a short list must end.
func pagedNames(t *testing.T, h *harness, c *http.Client, path, field string) []string {
	t.Helper()
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	var got []string
	cursor := ""
	for pages := 0; pages < 20; pages++ {
		out := h.call(c, "GET", path+sep+"limit=3&cursor="+cursor, "", "", 200)
		for _, r := range out["data"].([]any) {
			got = append(got, r.(map[string]any)[field].(string))
		}
		if cursor = out["next_cursor"].(string); cursor == "" {
			return got
		}
	}
	t.Fatalf("%s never ended", path)
	return nil
}

func wantOrder(t *testing.T, what string, got []string, want ...string) {
	t.Helper()
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("%s: got %v, want %v", what, got, want)
	}
}
