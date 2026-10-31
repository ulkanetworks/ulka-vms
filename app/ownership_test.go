package app

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// owners says which module owns each table and SQL function. A module's queries may name only its own, and other
// modules reach them through its Go functions. A new table or function goes under exactly one module here.
var owners = map[string][]string{
	"core": {"tenants", "users", "tenant_members", "sessions", "api_keys", "email_tokens", "invites",
		"usage_records", "support_visits", "retention_core", "session_seen", "user_signed_in", "api_key_lookup", "email_token_lookup", "invite_lookup", "login_lookup", "session_lookup", "signup"},
	"transcoder": {"encode_tasks", "scheduler_claim", "scheduler_renew", "scheduler_release", "scheduler_exhausted", "scheduler_written_off"},
	"video": {"libraries", "video_defaults", "folders", "transcoding_presets", "assets", "uploads", "jobs", "signing_keys", "video_delivery",
		"expired_uploads", "trashed_due_for_purge", "video_lookup", "sources_due_for_deletion", "stored_minutes", "upload_state", "upload_begin",
		"playback_reports", "playback_reports_expire"},
	"cdn": {"cdn_distributions", "cdn_domains", "cdn_platform", "cdn_ip_reputation", "cdn_deployments", "cdn_deployment_events", "cdn_purges", "cdn_certs", "cdn_link_keys", "cdn_auto_certs", "cdn_certs_due", "cdn_take_hostname", "cdn_host_owners",
		"cdn_distribution_image_lookup", "cdn_distributions_all", "cdn_distributions_capped", "cdn_distributions_with_alerts", "cdn_distributions_exporting", "retention_cdn"},
	"images":   {"image_sources", "image_delivery", "image_source_lookup"},
	"webhooks": {"webhook_endpoints", "webhook_deliveries", "retention_webhooks"},
	"live": {"live_servers", "live_tokens", "live_streams", "live_distributions", "live_pool_token", "live_install_step", "live_enrol",
		"live_server_auth", "live_server_get", "live_server_streams", "live_server_secrets", "live_server_report", "live_servers_due",
		"live_servers_went_offline", "live_server_set_dns", "live_server_set_cert", "live_server_set_tests", "live_pool_servers", "live_admin_token",
		"live_admin_servers", "live_admin_streams", "live_admin_update", "live_server_delete", "retention_live"},
	// The admins' back office reads across modules only through narrow ops_ functions, never tables.
	"ops": {"admins", "admin_sessions", "admin_audit", "admin_login_lookup", "nodes", "ops_asset_counts",
		"ops_cdn_counts", "ops_cdn_deployments", "ops_cdn_deployment_events", "ops_cdn_failures", "ops_cdn_distribution", "ops_daily", "ops_get_limits",
		"ops_recent_assets", "ops_tenants", "ops_tenants_list", "ops_set_user_disabled", "ops_audit_expire", "ops_cdn_distributions_by_app", "ops_videos_page", "ops_videos_summary", "ops_video", "ops_tenant", "ops_people_page", "ops_person", "ops_image_sources_page", "ops_image_source", "ops_cdn_distributions_page", "ops_cdn_distribution_detail", "ops_tenant_names", "ops_certificates_page", "ops_tls_counts", "ops_domains_page", "ops_cdn_provider_counts", "ops_cdn_certificate", "ops_playback_report"},
}

func TestModulesOwnTheirData(t *testing.T) {
	owner := map[string]string{}
	for m, names := range owners {
		for _, n := range names {
			owner[n] = m
		}
	}
	named := regexp.MustCompile(`\b(?:from|join|into|update)\s+([a-z_][a-z0-9_]*)`)
	files, _ := filepath.Glob("../*/queries/*.sql")
	for _, f := range files {
		module := strings.Split(filepath.ToSlash(f), "/")[1]
		b, _ := os.ReadFile(f)
		sql := regexp.MustCompile(`--[^\n]*`).ReplaceAllString(strings.ToLower(string(b)), "")
		ctes := map[string]bool{} // names a WITH defines in the same file are the query's own
		for _, m := range regexp.MustCompile(`\b([a-z_][a-z0-9_]*)\s+as\s*\(`).FindAllStringSubmatch(sql, -1) {
			ctes[m[1]] = true
		}
		for _, m := range named.FindAllStringSubmatch(sql, -1) {
			switch n := m[1]; {
			case n == "select" || n == "set" || n == "unnest" || n == "jsonb_array_elements" || ctes[n]:
			case owner[n] == "":
				t.Errorf("%s names %s, which no module owns: add it to owners", f, n)
			case owner[n] != module:
				t.Errorf("%s names %s, owned by %s: call %s's Go functions instead", f, n, owner[n], owner[n])
			}
		}
	}

	// Generated query packages are private to their module; core's is the shared kernel's.
	dbImport := regexp.MustCompile(`^github\.com/ulkanetworks/ulka-vms/([a-z]+)/db$`)
	gofiles, _ := filepath.Glob("../*/*.go")
	for _, f := range gofiles {
		module := strings.Split(filepath.ToSlash(f), "/")[1]
		if strings.HasSuffix(f, "_test.go") || module == "e2e" {
			continue
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), f, nil, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		for _, imp := range parsed.Imports {
			if m := dbImport.FindStringSubmatch(strings.Trim(imp.Path.Value, `"`)); m != nil && m[1] != module && m[1] != "core" {
				t.Errorf("%s imports %s's queries: use %s's Go functions instead", f, m[1], m[1])
			}
		}
	}
}

// A module meant to stand alone imports only core. The transcoder knows nothing of videos, libraries or playback:
// whoever owns the videos implements transcoder.Hooks (video does), so it can be lifted out as a service later.
func TestStandaloneModulesImportOnlyCore(t *testing.T) {
	for _, module := range []string{"transcoder"} {
		files, _ := filepath.Glob("../" + module + "/*.go")
		for _, f := range files {
			if strings.HasSuffix(f, "_test.go") {
				continue
			}
			parsed, err := parser.ParseFile(token.NewFileSet(), f, nil, parser.ImportsOnly)
			if err != nil {
				t.Fatal(err)
			}
			for _, imp := range parsed.Imports {
				path := strings.Trim(imp.Path.Value, `"`)
				if rest, ok := strings.CutPrefix(path, "github.com/ulkanetworks/ulka-vms/"); ok && !strings.HasPrefix(rest, "core") && !strings.HasPrefix(rest, module) {
					t.Errorf("%s imports %s: %s may use only core", f, path, module)
				}
			}
		}
	}
}
