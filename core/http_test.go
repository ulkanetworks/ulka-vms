package core

import (
	"net/http/httptest"
	"testing"
	"time"
)

// An empty list is [] and an empty map {}: a page reading .length or .map on null crashes (the admin Overview did).
func TestWriteJSONEmptyListsAreArrays(t *testing.T) {
	type row struct {
		List    []string          `json:"list"`
		Map     map[string]int    `json:"map"`
		Ptr     *string           `json:"ptr"`
		Omitted []string          `json:"omitted,omitempty"`
		At      time.Time         `json:"at"`
		Nested  map[string][]int  `json:"nested"`
		Rows    []map[string]bool `json:"rows"`
	}
	w := httptest.NewRecorder()
	WriteJSON(w, 200, row{At: time.Date(2026, 10, 18, 10, 0, 0, 0, time.UTC), Nested: map[string][]int{"a": nil}})
	want := `{"list":[],"map":{},"ptr":null,"at":"2026-10-18T10:00:00Z","nested":{"a":[]},"rows":[]}` + "\n"
	if got := w.Body.String(); got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}
