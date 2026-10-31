package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/ulkanetworks/ulka-vms/core"

	"github.com/ulkanetworks/ulka-vms/api"
)

// The console-only and admin routes the public spec leaves out on purpose, by how they're registered.
var (
	internalHandlers = []string{"playReport", "signup", "login", "verifyEmail", "requestPasswordReset", "confirmPasswordReset", "acceptInvite", "lookupInvite", "opsActingEnter", "uploadPreflight", "clientError",
		"installScript", "enrol", "installStep", "agentNext", "agentReport", "agentReplies", "agentGoodbye", "agentManifest", "agentFile"}
	// Codes only internal routes return, though they live in a public package.
	internalCodes = map[string]string{"lua_unsupported": "custom code is set only by Ulka admins",
		"invalid_custom_code":      "custom code is set only by Ulka admins",
		"invalid_platform":         "platform TLS is set only by Ulka admins",
		"live_token_invalid":       "only the Live Server installer sends install tokens",
		"live_server_not_removing": "only Ulka admins forget servers",
		"live_server_has_streams":  "only Ulka admins remove pool servers, which hold other workspaces' streams",
		"report_too_soon":          "only Ulka's own check page sends viewer reports"}
)

var (
	routeRe = regexp.MustCompile(`HandleFunc\("([A-Z]+) ([^"]+)", (?:[a-z]+\.)?(?:Auth\(([^,]+),|opsAuth|([a-zA-Z]+))`)
	codeRe  = regexp.MustCompile(`Code: "([a-z_]+)"|WriteError\(w, http\.[A-Za-z]+, "([a-z_]+)"\)|settingsError\("([a-z_]+)"\)|tusd\.NewError\("([a-z_]+)"`)
)

type route struct{ method, path, perm string } // perm: "video:read", "any", "public" or "internal"

func routes(t *testing.T) []route {
	files, _ := filepath.Glob("../*/*.go")
	var out []route
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range routeRe.FindAllStringSubmatch(string(b), -1) {
			r := route{m[1], strings.ReplaceAll(m[2], "...}", "}"), ""}
			switch arg := strings.Trim(m[3], `"`); {
			case strings.HasPrefix(r.path, "/v1/admin"), arg == "core.Session", slices.Contains(internalHandlers, m[4]):
				r.perm = "internal"
			case arg == "core.Anyone":
				r.perm = "any"
			case arg != "":
				r.perm = arg
			default:
				r.perm = "public"
			}
			out = append(out, r)
		}
	}
	return out
}

type spec struct {
	Paths        map[string]map[string]json.RawMessage `json:"paths"`
	CommonErrors map[string]string                     `json:"x-ulka-common-errors"`
}

type operation struct {
	Security   *[]any   `json:"security"`
	Permission string   `json:"x-ulka-permission"`
	Errors     []string `json:"x-ulka-errors"`
}

// TestSpecMatchesRoutes fails when the public API and its description disagree: a route missing from the spec,
// an operation for a route that doesn't exist, or the wrong permission.
func TestSpecMatchesRoutes(t *testing.T) {
	var s spec
	if err := json.Unmarshal(api.Spec, &s); err != nil {
		t.Fatal(err)
	}
	documented := map[string]operation{}
	for path, methods := range s.Paths {
		for method, raw := range methods {
			if method == "parameters" {
				continue
			}
			var op operation
			if err := json.Unmarshal(raw, &op); err != nil {
				t.Fatalf("%s %s: %v", method, path, err)
			}
			documented[strings.ToUpper(method)+" "+path] = op
		}
	}
	seen := map[string]bool{}
	for _, r := range routes(t) {
		key := r.method + " " + r.path
		if key == "GET /play/{path}" {
			key = "GET /{library}/{video}/{file}" // the player host's addresses; Caddy maps them under /play/
		}
		seen[key] = true
		op, ok := documented[key]
		switch {
		case r.perm == "internal" || key == "GET /v1/openapi.json":
			if ok {
				t.Errorf("%s is internal but documented", key)
			}
		case !ok:
			t.Errorf("%s is missing from api/openapi.json", key)
		case r.perm == "public" && (op.Security == nil || len(*op.Security) != 0):
			t.Errorf("%s needs no key: give it \"security\": []", key)
		case r.perm != "public" && op.Permission != r.perm:
			t.Errorf("%s: spec says permission %q, code says %q", key, op.Permission, r.perm)
		}
	}
	for key := range documented {
		if !seen[key] {
			t.Errorf("%s is documented but no such route exists", key)
		}
	}
}

// TestSpecListsErrorCodes fails when a public package can return an error code the spec doesn't mention.
func TestSpecListsErrorCodes(t *testing.T) {
	var s spec
	if err := json.Unmarshal(api.Spec, &s); err != nil {
		t.Fatal(err)
	}
	known := map[string]bool{}
	for code := range s.CommonErrors {
		known[code] = true
	}
	for _, methods := range s.Paths {
		for _, raw := range methods {
			var op operation
			json.Unmarshal(raw, &op)
			for _, c := range op.Errors {
				known[c] = true
			}
		}
	}
	for _, pkg := range []string{"video", "cdn", "images", "live", "webhooks", "usage", "notices"} {
		files, _ := filepath.Glob("../" + pkg + "/*.go")
		for _, f := range files {
			if strings.HasSuffix(f, "_test.go") {
				continue
			}
			b, _ := os.ReadFile(f)
			for _, m := range codeRe.FindAllStringSubmatch(string(b), -1) {
				code := m[1] + m[2] + m[3] + m[4]
				if !known[code] && internalCodes[code] == "" {
					t.Errorf("%s: error code %q isn't in api/openapi.json", f, code)
				}
				known[code] = true
			}
		}
	}
}

// TestEveryCodeHasWords fails when the API could send a code without a message: clients show only the API's words.
func TestEveryCodeHasWords(t *testing.T) {
	var s spec
	if err := json.Unmarshal(api.Spec, &s); err != nil {
		t.Fatal(err)
	}
	var codes []string
	for code := range s.CommonErrors {
		codes = append(codes, code)
	}
	for _, methods := range s.Paths {
		for _, raw := range methods {
			var op operation
			if json.Unmarshal(raw, &op) == nil {
				codes = append(codes, op.Errors...)
			}
		}
	}
	files, _ := filepath.Glob("../*/*.go")
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, _ := os.ReadFile(f)
		for _, m := range codeRe.FindAllStringSubmatch(string(b), -1) {
			codes = append(codes, m[1]+m[2]+m[3]+m[4])
		}
	}
	for _, c := range codes {
		if core.Messages[c] == "" {
			t.Errorf("error code %q has no words in core.Messages", c)
		}
	}
}

// TestWebhookEventsMatchSpec: every event the console offers (core.WebhookEvents) is described under the spec's
// webhooks, and nothing else is.
func TestWebhookEventsMatchSpec(t *testing.T) {
	var s struct {
		Webhooks map[string]json.RawMessage `json:"webhooks"`
	}
	if err := json.Unmarshal(api.Spec, &s); err != nil {
		t.Fatal(err)
	}
	for _, e := range core.WebhookEvents {
		if _, ok := s.Webhooks[e.Type]; !ok {
			t.Errorf("%s is in core.WebhookEvents but not the spec's webhooks", e.Type)
		}
	}
	for name := range s.Webhooks {
		if !core.IsWebhookEvent(name) {
			t.Errorf("%s is in the spec's webhooks but not core.WebhookEvents", name)
		}
	}
}

// TestSpecSections: every operation sits in one of the spec's sections (its first tag), and in one of that section's
// groups when it has some, so the API reference never drops an operation from its pages.
func TestSpecSections(t *testing.T) {
	var s struct {
		Tags []struct {
			Name   string   `json:"name"`
			Groups []string `json:"x-ulka-groups"`
		} `json:"tags"`
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(api.Spec, &s); err != nil {
		t.Fatal(err)
	}
	groups := map[string][]string{}
	for _, tag := range s.Tags {
		groups[tag.Name] = tag.Groups
	}
	for path, methods := range s.Paths {
		for method, raw := range methods {
			var op struct {
				Tags  []string `json:"tags"`
				Group string   `json:"x-ulka-group"`
			}
			if method == "parameters" || json.Unmarshal(raw, &op) != nil {
				continue
			}
			key := strings.ToUpper(method) + " " + path
			gs, ok := groups[firstOr(op.Tags)]
			switch {
			case !ok:
				t.Errorf("%s: tag %q isn't one of the spec's tags", key, firstOr(op.Tags))
			case len(gs) > 0 && !slices.Contains(gs, op.Group):
				t.Errorf("%s: x-ulka-group %q isn't one of %s's groups", key, op.Group, op.Tags[0])
			case len(gs) == 0 && op.Group != "":
				t.Errorf("%s: x-ulka-group set, but %s has no groups", key, op.Tags[0])
			}
		}
	}
}

func firstOr(tags []string) string {
	if len(tags) == 0 {
		return ""
	}
	return tags[0]
}
