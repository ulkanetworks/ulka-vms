package e2e

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ulkanetworks/ulka-vms/app"
	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/migrations"
)

// harness runs the API against a migrated database, connected as ulka_app, and a real S3 bucket.
type harness struct {
	t       *testing.T
	pool    *pgxpool.Pool
	store   core.Storage
	ts      *httptest.Server
	handler http.Handler
	cfg     app.Config
	// stopEncoder stops the test node that encodes video, for tests that drive the scheduler by hand.
	stopEncoder func()
}

// migrated brings the test database up to date once per run, so it can't drift behind migrations/.
var migrated sync.Once

var emptied sync.Once

var testSealKey = bytes.Repeat([]byte{1}, 32)

// testMigrations is ulka-vms's schema; the test database is migrated like a real one.
var testMigrations = core.Migrations{FS: migrations.FS}

// resetBucket makes the test bucket if needed and deletes everything in it.
func resetBucket(ctx context.Context, st core.Storage) error {
	_, err := st.S3.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: &st.Bucket})
	var owned *types.BucketAlreadyOwnedByYou
	var exists *types.BucketAlreadyExists
	if err != nil && !errors.As(err, &owned) && !errors.As(err, &exists) {
		return err
	}
	pages := s3.NewListObjectsV2Paginator(st.S3, &s3.ListObjectsV2Input{Bucket: &st.Bucket})
	for pages.HasMorePages() {
		page, err := pages.NextPage(ctx)
		if err != nil {
			return err
		}
		if len(page.Contents) == 0 {
			continue
		}
		ids := make([]types.ObjectIdentifier, len(page.Contents))
		for i, o := range page.Contents {
			ids[i] = types.ObjectIdentifier{Key: o.Key}
		}
		if _, err := st.S3.DeleteObjects(ctx, &s3.DeleteObjectsInput{Bucket: &st.Bucket, Delete: &types.Delete{Objects: ids, Quiet: aws.Bool(true)}}); err != nil {
			return err
		}
	}
	return nil
}

func newHarness(t *testing.T) *harness { return newHarnessWith(t, nil) }

// newHarnessWith lets a test change the configuration before the API and encoder start.
func newHarnessWith(t *testing.T, configure func(*app.Config)) *harness {
	return newHarnessFull(t, configure, app.Extension{})
}

// newHarnessWithExt runs the API with what an application built on ulka-vms adds.
func newHarnessWithExt(t *testing.T, ext app.Extension) *harness { return newHarnessFull(t, nil, ext) }

func newHarnessFull(t *testing.T, configure func(*app.Config), ext app.Extension) *harness {
	env := func(name string) string {
		v := os.Getenv(name)
		if v == "" {
			t.Fatal(name + " is not set")
		}
		return v
	}
	migrated.Do(func() {
		if err := core.Migrate(t.Context(), env("TEST_OWNER_DATABASE_URL"), testMigrations); err != nil {
			t.Fatal(err)
		}
		if err := provisionClickHouse(t.Context(), env("TEST_CLICKHOUSE_URL")); err != nil {
			t.Fatal(err)
		}
	})
	pool, err := core.Connect(t.Context(), env("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	store := core.Storage{
		S3: s3.New(s3.Options{
			Region: env("S3_REGION"), BaseEndpoint: aws.String(env("S3_ENDPOINT")), UsePathStyle: true,
			Credentials: credentials.NewStaticCredentialsProvider(env("S3_ACCESS_KEY_ID"), env("S3_SECRET_ACCESS_KEY"), ""),
		}),
		// Tests get their own bucket, emptied when a run starts: runs upload real videos (7 GB piled up in the
		// development bucket before this).
		Bucket: env("S3_BUCKET") + "-test",
	}
	emptied.Do(func() {
		if err := resetBucket(t.Context(), store); err != nil {
			t.Fatal(err)
		}
	})
	h := &harness{t: t, pool: pool, store: store}
	// The API needs its own URL, known only once the server is up, so the handler is filled in after.
	var handler http.Handler
	h.handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handler.ServeHTTP(w, r) })
	core.RouteSeen = exercised // TestMain checks every video route was reached (coverage_test.go)
	h.ts = httptest.NewTLSServer(h.handler)
	// Tests read segments straight from the bucket; production puts nginx here.
	h.cfg = app.Config{
		PublicURL:     h.ts.URL,
		OriginURL:     env("S3_ENDPOINT") + "/" + store.Bucket,
		PlayerURL:     h.ts.URL + "/play",
		SignupOpen:    true,
		ClickHouseURL: env("TEST_CLICKHOUSE_URL"),
		SealKey:       testSealKey,
		// Requests come from this machine; a test names the viewer with X-Forwarded-For, as a proxy would.
		TrustedProxies: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8"), netip.MustParsePrefix("::1/128")},
	}
	if configure != nil {
		configure(&h.cfg)
	}
	if path := os.Getenv("GEOIP_DB"); path != "" {
		if !filepath.IsAbs(path) { // .env names it from the repository's root; tests run a folder down
			path = filepath.Join("..", path)
		}
		if h.cfg.Geo, err = core.OpenGeo(path); err != nil {
			t.Fatal(err)
		}
	}
	handler, err = app.Handler(pool, store, h.cfg, ext)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.ts.Close)
	// Every test gets a node that encodes, since the scheduler hands video pieces only to nodes that ask.
	rc, err := river.NewClient(riverpgxv5.New(pool), &river.Config{Schema: core.RiverSchema})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := app.StartEncoder(ctx, pool, store, h.cfg, rc, 2)
	h.stopEncoder = func() { cancel(); <-done }
	t.Cleanup(h.stopEncoder)
	return h
}

func (h *harness) client() *http.Client {
	c := *h.ts.Client()
	c.Jar, _ = cookiejar.New(nil)
	return &c
}

func (h *harness) call(c *http.Client, method, path, auth, body string, wantStatus int) map[string]any {
	h.t.Helper()
	req, _ := http.NewRequest(method, h.ts.URL+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if auth != "" {
		req.Header.Set("Authorization", "Bearer "+auth)
	}
	res, err := c.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	json.NewDecoder(res.Body).Decode(&out)
	if res.StatusCode != wantStatus {
		h.t.Fatalf("%s %s: got %d %v, want %d", method, path, res.StatusCode, out, wantStatus)
	}
	return out
}

// signup creates a tenant and returns a logged-in client plus an API key for it.
func (h *harness) signup(name string) (*http.Client, string) {
	c := h.client()
	h.call(c, "POST", "/v1/signup", "", `{"email":"`+strings.ToLower(rand.Text())+`@`+name+`.test","password":"correct horse battery","tenant_name":"`+name+`"}`, 201)
	return c, h.call(c, "POST", "/v1/api-keys", "", `{"name":"test","scopes":["video:write","webhooks:write"]}`, 201)["key"].(string)
}

func TestTenantIsolation(t *testing.T) {
	h := newHarness(t)
	call, newClient := h.call, h.client

	a, b := newClient(), newClient()
	emailA := strings.ToLower(rand.Text()) + "@a.test"
	call(a, "POST", "/v1/signup", "", `{"email":"`+emailA+`","password":"correct horse battery","tenant_name":"A"}`, 201)
	call(b, "POST", "/v1/signup", "", `{"email":"`+strings.ToLower(rand.Text())+`@b.test","password":"correct horse battery","tenant_name":"B"}`, 201)
	call(newClient(), "POST", "/v1/signup", "", `{"email":"`+strings.ToUpper(emailA)+`","password":"correct horse battery","tenant_name":"A2"}`, 409)

	keyA := call(a, "POST", "/v1/api-keys", "", `{"name":"a","scopes":["video:read"]}`, 201)
	keyB := call(b, "POST", "/v1/api-keys", "", `{"name":"b","scopes":["video:read"]}`, 201)

	listA := call(a, "GET", "/v1/api-keys", "", "", 200)["data"].([]any)
	if len(listA) != 1 || listA[0].(map[string]any)["id"] != keyA["id"] {
		t.Fatalf("tenant A sees %v", listA)
	}
	call(a, "DELETE", "/v1/api-keys/"+keyB["id"].(string), "", "", 404)
	call(a, "DELETE", "/v1/api-keys/not-a-uuid", "", "", 404)
	if listB := call(b, "GET", "/v1/api-keys", "", "", 200)["data"].([]any); len(listB) != 1 {
		t.Fatalf("tenant B's key was touched: %v", listB)
	}

	meA := call(a, "GET", "/v1/me", "", "", 200)
	meKey := call(newClient(), "GET", "/v1/me", keyA["key"].(string), "", 200)
	if meKey["tenant"].(map[string]any)["id"] != meA["tenant"].(map[string]any)["id"] || meKey["user"] != nil {
		t.Fatalf("api key resolved to %v, want tenant %v", meKey, meA["tenant"])
	}
	call(newClient(), "GET", "/v1/api-keys", keyA["key"].(string), "", 401)
	call(newClient(), "GET", "/v1/me", "sk_wrong", "", 401)
	call(newClient(), "GET", "/v1/me", "", "", 401)

	call(a, "POST", "/v1/logout", "", "", 204)
	call(a, "GET", "/v1/me", "", "", 401)
	call(a, "POST", "/v1/login", "", `{"email":"`+emailA+`","password":"wrong password here"}`, 401)
	call(a, "POST", "/v1/login", "", `{"email":"`+emailA+`","password":"correct horse battery"}`, 200)
	call(a, "DELETE", "/v1/api-keys/"+keyA["id"].(string), "", "", 204)

	var visible int
	if err := h.pool.QueryRow(t.Context(), "SELECT count(*) FROM api_keys").Scan(&visible); err != nil || visible != 0 {
		t.Fatalf("without app.tenant_id the app role sees %d api keys (err %v)", visible, err)
	}
}

func TestAPIKeyPermissions(t *testing.T) {
	h := newHarness(t)
	owner, _ := h.signup("keys")
	key := func(body string) string { return h.call(owner, "POST", "/v1/api-keys", "", body, 201)["key"].(string) }

	for _, bad := range []string{`{"name":"x"}`, `{"name":"x","scopes":["video:read","video:write"]}`, `{"name":"x","scopes":["billing:read"]}`} {
		h.call(owner, "POST", "/v1/api-keys", "", bad, 400)
	}
	h.call(owner, "POST", "/v1/api-keys", "", `{"name":"x","scopes":["video:read"],"allowed_ips":["0.0.0.0/0"]}`, 400)
	h.call(owner, "POST", "/v1/api-keys", "", `{"name":"x","scopes":["video:read"],"expires_at":"2020-01-01T00:00:00Z"}`, 400)

	// Read covers reading only; write includes read; other products and account routes stay closed.
	reader := key(`{"name":"reader","scopes":["video:read"]}`)
	h.call(h.client(), "GET", "/v1/assets", reader, "", 200)
	h.call(h.client(), "POST", "/v1/uploads", reader, "", 403)
	h.call(h.client(), "GET", "/v1/webhook-endpoints", reader, "", 403)
	h.call(h.client(), "GET", "/v1/usage", reader, "", 200)
	h.call(h.client(), "GET", "/v1/members", reader, "", 401)
	writer := key(`{"name":"writer","scopes":["webhooks:write"]}`)
	h.call(h.client(), "GET", "/v1/webhook-endpoints", writer, "", 200)
	h.call(h.client(), "GET", "/v1/assets", writer, "", 403)

	// Tests reach the API from 127.0.0.1.
	h.call(h.client(), "GET", "/v1/assets", key(`{"name":"here","scopes":["video:read"],"allowed_ips":["127.0.0.1"]}`), "", 200)
	h.call(h.client(), "GET", "/v1/assets", key(`{"name":"away","scopes":["video:read"],"allowed_ips":["203.0.113.0/24"]}`), "", 403)

	soon := key(`{"name":"soon","scopes":["video:read"],"expires_at":"` + time.Now().Add(time.Second).UTC().Format(time.RFC3339Nano) + `"}`)
	h.call(h.client(), "GET", "/v1/assets", soon, "", 200)
	time.Sleep(1100 * time.Millisecond)
	h.call(h.client(), "GET", "/v1/assets", soon, "", 401)

	for _, k := range h.call(owner, "GET", "/v1/api-keys", "", "", 200)["data"].([]any) {
		if k := k.(map[string]any); k["name"] == "reader" && k["last_used_at"] == nil {
			t.Fatalf("last use not recorded: %v", k)
		}
	}
}

func TestListPaging(t *testing.T) {
	h := newHarness(t)
	_, key := h.signup("paging")
	for _, ref := range []string{"order-1", "order-2", "100%_real"} {
		up := h.call(h.client(), "POST", "/v1/uploads", key, "", 201)
		h.call(h.client(), "POST", "/v1/assets", key, `{"upload_id":"`+up["id"].(string)+`","passthrough":"`+ref+`"}`, 201)
	}
	count := func(query string) int {
		return len(h.call(h.client(), "GET", "/v1/assets?"+query, key, "", 200)["data"].([]any))
	}
	for query, want := range map[string]int{
		"": 3, "q=ORDER-2": 1, "q=100%25_": 1 /* wildcards are literal */, "q=%25": 1,
		"status=waiting": 3, "status=ready": 0, "q=order&status=waiting": 2,
	} {
		if n := count(query); n != want {
			t.Errorf("?%s: %d rows, want %d", query, n, want)
		}
	}
	// Pages continue from a cursor, newest first, until next_cursor comes back empty.
	first := h.call(h.client(), "GET", "/v1/assets?limit=2", key, "", 200)
	next := h.call(h.client(), "GET", "/v1/assets?limit=2&cursor="+first["next_cursor"].(string), key, "", 200)
	var refs []string
	for _, a := range append(first["data"].([]any), next["data"].([]any)...) {
		refs = append(refs, a.(map[string]any)["passthrough"].(string))
	}
	if strings.Join(refs, ",") != "100%_real,order-2,order-1" || next["next_cursor"] != "" {
		t.Errorf("pages: %v, next %q", refs, next["next_cursor"])
	}
	if first["total"] != 3.0 || next["total"] != 3.0 || h.call(h.client(), "GET", "/v1/assets?q=order&limit=1", key, "", 200)["total"] != 2.0 {
		t.Errorf("assets total: %v %v", first["total"], next["total"])
	}
	h.call(h.client(), "GET", "/v1/assets?cursor=not-a-cursor", key, "", 400)
	h.call(h.client(), "GET", "/v1/assets?status=bogus", key, "", 400)
	h.call(h.client(), "GET", "/v1/assets?limit=500", key, "", 400)
}

func TestNotices(t *testing.T) {
	h := newHarness(t)
	owner, _ := h.signup("notices")
	soon := time.Now().Add(48 * time.Hour).UTC().Format(time.RFC3339)
	h.call(owner, "POST", "/v1/api-keys", "", `{"name":"soon","scopes":["video:read"],"expires_at":"`+soon+`"}`, 201)
	reader := h.call(owner, "POST", "/v1/api-keys", "", `{"name":"reader","scopes":["video:read"]}`, 201)["key"].(string)

	kinds := func(c *http.Client, key string) (out []string) {
		for _, n := range h.call(c, "GET", "/v1/notices", key, "", 200)["data"].([]any) {
			out = append(out, n.(map[string]any)["kind"].(string))
		}
		return out
	}
	if got := kinds(owner, ""); fmt.Sprint(got) != "[key_expiring]" {
		t.Fatalf("owner's notices: %v", got)
	}
	// Notices about keys are only for those who manage keys.
	if got := kinds(h.client(), reader); len(got) != 0 {
		t.Fatalf("a video:read key sees %v", got)
	}
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for start := time.Now(); time.Since(start) < 30*time.Second; time.Sleep(100 * time.Millisecond) { // CI runners are slower than this machine
		if ok() {
			return
		}
	}
	t.Fatalf("timed out waiting for %s", what)
}
