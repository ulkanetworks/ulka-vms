// Package app assembles the modules into the API handler and the worker's River client, with what an application
// built on ulka-vms adds (Extension).
package app

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"maps"
	"net/http"
	"net/netip"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivertype"

	"github.com/ulkanetworks/ulka-vms/accounts"
	"github.com/ulkanetworks/ulka-vms/api"
	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/migrations"
	"github.com/ulkanetworks/ulka-vms/notices"
	"github.com/ulkanetworks/ulka-vms/player"
	"github.com/ulkanetworks/ulka-vms/transcoder"
	"github.com/ulkanetworks/ulka-vms/usage"
	"github.com/ulkanetworks/ulka-vms/video"
	"github.com/ulkanetworks/ulka-vms/webhooks"
)

// Extension is what an application built on ulka-vms adds: its settings, modules, jobs and schema. The zero value
// is ulka-vms on its own.
type Extension struct {
	Name       string // the command's name, in its usage line and as its migrations' prefix
	Migrations fs.FS  // its schema, applied after ulka-vms's
	// Configure reads its settings into cfg at start, exiting on a bad one as ulka-vms does with its own.
	Configure func(cfg *Config)
	// CheckEnv finds its settings that would make a public deployment look healthy while it isn't (see CheckEnv).
	CheckEnv func(get func(string) string) (errs, warns []string)
	Commands map[string]func(ctx context.Context) error // more subcommands beside migrate, api and worker
	// Routes adds its API; the returned function, if any, wraps the whole handler.
	Routes  func(mux *http.ServeMux, d *core.Deps) (wrap func(http.Handler) http.Handler, err error)
	Video   func(d *core.Deps) video.Options // what it adds to video
	Workers func(w *river.Workers, d *core.Deps)
	Jobs    []*river.PeriodicJob
	Queues  map[string]river.QueueConfig // its own queues, beside ulka-vms's
	// OpenAPI is the application's whole API description (Ulka VMS's routes and its own), served at
	// /v1/openapi.json in place of Ulka VMS's.
	OpenAPI []byte
	// ServeNode runs the worker's River client until ctx ends (registering the machine, say); nil just runs it.
	ServeNode func(ctx context.Context, pool *pgxpool.Pool, client *river.Client[pgx.Tx], queues map[string]river.QueueConfig, jobs bool) error
}

// migrationSets is ulka-vms's schema, then the extension's.
func (e Extension) migrationSets() []core.Migrations {
	sets := []core.Migrations{{FS: migrations.FS}}
	if e.Migrations != nil {
		sets = append(sets, core.Migrations{Prefix: e.Name + "/", FS: e.Migrations})
	}
	return sets
}

// Queues is ulka-vms's queues, with a sensible concurrency for tests and a laptop. Real nodes choose their own set
// with WORKER_QUEUES (ParseQueues), so an encoding box and a webhook box can run different work.
var Queues = map[string]river.QueueConfig{
	"interactive": {MaxWorkers: 4},
	"standard":    {MaxWorkers: 2},
	"webhooks":    {MaxWorkers: 20},
	"maintenance": {MaxWorkers: 2},
}

// allQueues is ulka-vms's queues and the extension's.
func (e Extension) allQueues() map[string]river.QueueConfig {
	out := maps.Clone(Queues)
	maps.Copy(out, e.Queues)
	return out
}

// ParseQueues reads "interactive=8,standard=8" into the queues this node works and how many jobs of each at once;
// "none" is a node that only encodes.
func ParseQueues(s string, known map[string]river.QueueConfig) (map[string]river.QueueConfig, error) {
	out := map[string]river.QueueConfig{}
	if strings.TrimSpace(s) == "none" {
		return out, nil
	}
	for part := range strings.SplitSeq(s, ",") {
		name, n, ok := strings.Cut(strings.TrimSpace(part), "=")
		workers, err := strconv.Atoi(n)
		if _, isKnown := known[name]; !ok || !isKnown || err != nil || workers < 1 || workers > 1000 {
			return nil, fmt.Errorf("WORKER_QUEUES: %q is not queue=workers, with queue one of %s", part, strings.Join(slices.Sorted(maps.Keys(known)), ", "))
		}
		out[name] = river.QueueConfig{MaxWorkers: workers}
	}
	return out, nil
}

// ParseEncodeSlots reads WORKER_ENCODE_SLOTS: how many video pieces this node encodes at once. "auto" is one per
// transcoder.EncodeThreads cores (never fewer than one), so a bigger machine is given proportionally more; 0 takes none.
func ParseEncodeSlots(s string) (int, error) {
	if s == "auto" {
		return max(1, runtime.NumCPU()/transcoder.EncodeThreads), nil
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 0 || n > 1000 {
		return 0, fmt.Errorf("WORKER_ENCODE_SLOTS: %q is not auto or a number from 0 to 1000", s)
	}
	return n, nil
}

// StartEncoder starts this node's side of the scheduler beside its River client; stop it by cancelling ctx, then
// wait on the returned channel for the pieces already running.
func StartEncoder(ctx context.Context, pool *pgxpool.Pool, store core.Storage, cfg Config, rc *river.Client[pgx.Tx], slots int) <-chan struct{} {
	d := &core.Deps{Pool: pool, Store: store, SealKey: cfg.SealKey, River: rc, Keys: cfg.Keys}
	done := make(chan struct{})
	go func() {
		defer close(done)
		transcoder.RunEncoder(ctx, d, video.Hooks(d), rc.ID(), slots, transcoder.Encoders())
	}()
	return done
}

// Config is what the modules need beyond the database and storage.
type Config struct {
	PublicURL     string // where the API and the customer console are reached
	AdminURL      string // where the application's admins work, if it has any
	OriginURL     string // where video segments are
	PlayerURL     string // where viewers watch and stream
	DocsURL       string // where the guides and the API reference are read
	PlayerDemo    string // library/video the player host's home shows; empty for none
	SignupOpen    bool   // whether anyone may create a workspace (SIGNUP)
	ClickHouseURL string // where delivery logs and usage rollups are
	// Reverse proxies in front of the API, whose X-Forwarded-For names the caller (API key IP allow lists).
	TrustedProxies []netip.Prefix
	Geo            *core.Geo
	SealKey        []byte        // SEAL_KEY, 32 bytes
	Keys           core.KeyStore // a key service; nil keeps keys sealed in the database
}

// ParseProxies reads TRUSTED_PROXIES: "none", or comma-separated addresses and ranges.
func ParseProxies(s string) ([]netip.Prefix, error) {
	if s == "none" {
		return nil, nil
	}
	var out []netip.Prefix
	for _, v := range strings.Split(s, ",") {
		p, err := core.ParsePrefix(v)
		if err != nil {
			return nil, fmt.Errorf("TRUSTED_PROXIES: %q is not an address or range", v)
		}
		out = append(out, p)
	}
	return out, nil
}

// Handler builds the API over an already-connected pool.
func Handler(pool *pgxpool.Pool, store core.Storage, cfg Config, ext Extension) (http.Handler, error) {
	rc, err := river.NewClient(riverpgxv5.New(pool), &river.Config{Schema: core.RiverSchema})
	if err != nil {
		return nil, err
	}
	d := &core.Deps{Pool: pool, River: rc, Store: store, PublicURL: cfg.PublicURL, AdminURL: cfg.AdminURL, OriginURL: cfg.OriginURL, PlayerURL: cfg.PlayerURL, DocsURL: cfg.DocsURL, PlayerDemo: cfg.PlayerDemo, SignupOpen: cfg.SignupOpen, TrustedProxies: cfg.TrustedProxies, Geo: cfg.Geo, SealKey: cfg.SealKey, Keys: cfg.Keys}
	mux := http.NewServeMux()
	accounts.Routes(mux, d)
	videoOpts := video.Options{ClickHouseURL: cfg.ClickHouseURL}
	if ext.Video != nil {
		videoOpts = ext.Video(d)
		videoOpts.ClickHouseURL = cfg.ClickHouseURL
	}
	if err := video.Routes(mux, d, videoOpts, player.Docs); err != nil {
		return nil, err
	}
	player.Routes(mux, d)
	webhooks.Routes(mux, d)
	usage.Routes(mux, d)
	notices.Routes(mux, d)
	wrap := func(h http.Handler) http.Handler { return h }
	if ext.Routes != nil {
		w, err := ext.Routes(mux, d)
		if err != nil {
			return nil, err
		}
		if w != nil {
			wrap = w
		}
	}
	// The public API's description, for developers and generators; no key needed to read it.
	spec := api.Spec
	if ext.OpenAPI != nil {
		spec = ext.OpenAPI
	}
	mux.HandleFunc("GET /v1/openapi.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write(spec)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { core.WriteError(w, http.StatusNotFound, "not_found") })
	return core.Observe(mux, wrap(mux)), nil
}

// NewWorkerClient registers every module's workers and periodic jobs.
func NewWorkerClient(pool *pgxpool.Pool, store core.Storage, cfg Config, queues map[string]river.QueueConfig, ext Extension) (*river.Client[pgx.Tx], error) {
	d := &core.Deps{Pool: pool, Store: store, SealKey: cfg.SealKey, Keys: cfg.Keys}
	workers := river.NewWorkers()
	accounts.Workers(workers, d)
	video.Workers(workers, d)
	transcoder.Workers(workers, d, video.Hooks(d))
	webhooks.Workers(workers, d)
	usage.Workers(workers, d, cfg.ClickHouseURL)
	if ext.Workers != nil {
		ext.Workers(workers, d)
	}
	rc, err := river.NewClient(riverpgxv5.New(pool), &river.Config{
		Schema:       core.RiverSchema,
		Middleware:   []rivertype.Middleware{&core.JobMiddleware{}},
		Queues:       queues,
		Workers:      workers,
		JobTimeout:   core.JobTimeout,
		PeriodicJobs: slices.Concat(accounts.PeriodicJobs(), video.PeriodicJobs(), transcoder.PeriodicJobs(), usage.PeriodicJobs(), webhooks.PeriodicJobs(), ext.Jobs),
	})
	d.River = rc // workers insert jobs through d.River like handlers do; nil here once hid a failing fan-out
	return rc, err
}

// Serve connects, then answers HTTP on addr until ctx is cancelled.
func Serve(ctx context.Context, dsn, addr string, store core.Storage, cfg Config, ext Extension) error {
	pool, err := core.Connect(ctx, dsn)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := core.CheckMigrated(ctx, pool, ext.migrationSets()...); err != nil {
		return err
	}
	stop, err := core.StartObserving(ctx, "api", pool)
	if err != nil {
		return err
	}
	defer shutdownTelemetry(stop)
	h, err := Handler(pool, store, cfg, ext)
	if err != nil {
		return err
	}
	// No read or write timeout: uploads and downloads may stream for a long time. Idle keep-alives close after 2 minutes.
	srv := &http.Server{Addr: addr, Handler: h, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	slog.Info("api listening", "addr", addr)
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	core.BeginShutdown() // long waits end now, so the port is closed for seconds, not for a poll's length
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	err = srv.Shutdown(shutdownCtx)
	core.DrainLogs(shutdownCtx) // usage rows held in memory (downloads) go out before the process ends
	return err
}

// RunWorker runs River workers until ctx is cancelled (or the extension's ServeNode returns).
func RunWorker(ctx context.Context, dsn string, store core.Storage, cfg Config, queues map[string]river.QueueConfig, encodeSlots int, ext Extension) error {
	pool, err := core.Connect(ctx, dsn)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := core.CheckMigrated(ctx, pool, ext.migrationSets()...); err != nil {
		return err
	}
	stop, err := core.StartObserving(ctx, "worker", pool)
	if err != nil {
		return err
	}
	defer shutdownTelemetry(stop)
	if len(queues) == 0 && encodeSlots == 0 {
		return errors.New("this worker has nothing to do: WORKER_QUEUES is none and WORKER_ENCODE_SLOTS is 0")
	}
	client, err := NewWorkerClient(pool, store, cfg, queues, ext)
	if err != nil {
		return err
	}
	slog.Info("worker starting", "queues", queues, "encode_slots", encodeSlots)
	// What the node works on; video encoding is not a River queue but is shown beside them.
	shown := maps.Clone(queues)
	var encoding <-chan struct{} = closedChan
	encCtx, stopEncoding := context.WithCancel(ctx)
	defer stopEncoding()
	if encodeSlots > 0 {
		shown["encode"] = river.QueueConfig{MaxWorkers: encodeSlots}
		encoding = StartEncoder(encCtx, pool, store, cfg, client, encodeSlots)
	}
	serve := ext.ServeNode
	if serve == nil {
		serve = runClient
	}
	err = serve(ctx, pool, client, shown, len(queues) > 0)
	stopEncoding()
	// After a stop signal the running pieces get 30 seconds; after a drain, as long as one may take.
	wait := core.JobTimeout + time.Minute
	if ctx.Err() != nil {
		wait = 30 * time.Second
	}
	select {
	case <-encoding:
	case <-time.After(wait):
		slog.Warn("encodes still running at exit; their leases will lapse and another node takes them")
	}
	return err
}

// runClient runs River's client until ctx ends, then gives running jobs 30 seconds to finish.
func runClient(ctx context.Context, _ *pgxpool.Pool, client *river.Client[pgx.Tx], _ map[string]river.QueueConfig, jobs bool) error {
	if !jobs {
		<-ctx.Done()
		return nil
	}
	if err := client.Start(ctx); err != nil {
		return err
	}
	<-ctx.Done()
	stopCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return client.Stop(stopCtx)
}

var closedChan = func() chan struct{} { c := make(chan struct{}); close(c); return c }()

// shutdownTelemetry sends what's still buffered before the process exits.
func shutdownTelemetry(stop func(context.Context) error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := stop(ctx); err != nil {
		slog.Warn("flushing telemetry", "err", err)
	}
}
