package e2e

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/ulkanetworks/ulka-vms/api"
)

// Every public video route (the spec's Videos tag) must be reached by this suite: a route added without a
// test fails the full run. Hits are the mux patterns of every request the tests sent through the API.
var (
	hitsMu sync.Mutex
	hits   = map[string]bool{}
)

func exercised(pattern string) {
	if pattern == "" {
		return
	}
	hitsMu.Lock()
	hits[strings.ReplaceAll(pattern, "...}", "}")] = true // the spec writes {path} for a {path...} route
	hitsMu.Unlock()
}

var guardedTags = []string{"Videos"}

func TestMain(m *testing.M) {
	code := m.Run()
	// Only a full run can judge coverage; `-run TestX` reaches a few routes on purpose.
	if code != 0 || flag.Lookup("test.run").Value.String() != "" {
		os.Exit(code)
	}
	var s struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"` // a path holds its operations and a "parameters" list
	}
	if err := json.Unmarshal(api.Spec, &s); err != nil {
		fmt.Println("coverage: reading the spec:", err)
		os.Exit(1)
	}
	var missing []string
	hitsMu.Lock()
	for path, methods := range s.Paths {
		for method, raw := range methods {
			var op struct {
				Tags []string `json:"tags"`
			}
			if method == "parameters" || json.Unmarshal(raw, &op) != nil || !slices.ContainsFunc(op.Tags, func(t string) bool { return slices.Contains(guardedTags, t) }) {
				continue
			}
			if key := strings.ToUpper(method) + " " + path; !hits[key] {
				missing = append(missing, key)
			}
		}
	}
	hitsMu.Unlock()
	if len(missing) > 0 {
		sort.Strings(missing)
		fmt.Printf("FAIL: %d video routes have no end-to-end test (add one in e2e/):\n  %s\n", len(missing), strings.Join(missing, "\n  "))
		os.Exit(1)
	}
	os.Exit(0)
}
