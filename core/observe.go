package core

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"runtime"
	"runtime/debug"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/log/global"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.43.0"
	"go.opentelemetry.io/otel/trace"
)

// Ulka's own telemetry is OpenTelemetry: traces, metrics and logs go over OTLP to the endpoint in
// OTEL_EXPORTER_OTLP_ENDPOINT (the OpenTelemetry Collector, which writes them to ClickHouse; see deploy/otel-collector).
// Requests (otelhttp) and job runs (JobMiddleware) are trace roots; database queries over a millisecond and outgoing
// HTTP calls are their children. Without StartObserving the global providers are no-ops and nothing is recorded.

const instrumentation = "github.com/ulkanetworks/ulka-vms"

var tracer = otel.Tracer(instrumentation)

// StartObserving sets up OpenTelemetry for this process ("api" or "worker"; service.name ulka-api or ulka-worker)
// and returns what flushes and stops it on shutdown. slog keeps printing to stderr and also sends each line as an
// OTel log carrying the trace it happened in.
func StartObserving(ctx context.Context, service string, pool *pgxpool.Pool) (func(context.Context) error, error) {
	host, _ := os.Hostname()
	res, err := resource.Merge(resource.Default(), resource.NewWithAttributes(semconv.SchemaURL,
		semconv.ServiceName("ulka-"+service), semconv.HostName(host)))
	if err != nil {
		return nil, err
	}
	traceExp, err := otlptracehttp.New(ctx)
	if err != nil {
		return nil, err
	}
	metricExp, err := otlpmetrichttp.New(ctx)
	if err != nil {
		return nil, err
	}
	logExp, err := otlploghttp.New(ctx)
	if err != nil {
		return nil, err
	}
	tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(traceExp), sdktrace.WithResource(res))
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithReader(sdkmetric.NewPeriodicReader(metricExp, sdkmetric.WithInterval(time.Minute))),
		sdkmetric.WithResource(res))
	lp := sdklog.NewLoggerProvider(sdklog.WithProcessor(sdklog.NewBatchProcessor(logExp)), sdklog.WithResource(res))
	otel.SetTracerProvider(tp)
	otel.SetMeterProvider(mp)
	global.SetLoggerProvider(lp)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	http.DefaultTransport = otelhttp.NewTransport(http.DefaultTransport) // outgoing calls inside a trace become its spans
	slog.SetDefault(slog.New(bothHandlers{slog.NewTextHandler(os.Stderr, nil), otelslog.NewHandler(instrumentation, otelslog.WithLoggerProvider(lp))}))
	startMetrics(pool)
	return func(ctx context.Context) error {
		return errors.Join(tp.Shutdown(ctx), mp.Shutdown(ctx), lp.Shutdown(ctx))
	}, nil
}

// AddGauge reports fn's value as the metric ulka.<name> once a minute (for example, jobs waiting). It may be called
// before or after StartObserving: the global meter hands registrations on to the provider once it's set.
func AddGauge(name string, fn func(context.Context) (float64, error)) {
	meter := otel.Meter(instrumentation)
	g, err := meter.Float64ObservableGauge("ulka." + name)
	if err == nil {
		_, err = meter.RegisterCallback(func(ctx context.Context, o metric.Observer) error {
			if v, err := fn(ctx); err == nil {
				o.ObserveFloat64(g, v)
			}
			return nil
		}, g)
	}
	if err != nil {
		slog.Warn("registering a metric", "name", name, "err", err)
	}
}

// startMetrics reports the process's own gauges: memory, goroutines and its database pool.
func startMetrics(pool *pgxpool.Pool) {
	AddGauge("goroutines", func(context.Context) (float64, error) { return float64(runtime.NumGoroutine()), nil })
	AddGauge("memory.heap_mb", func(context.Context) (float64, error) {
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		return float64(m.HeapAlloc) / 1e6, nil
	})
	if pool == nil {
		return
	}
	AddGauge("db.connections.in_use", func(context.Context) (float64, error) { return float64(pool.Stat().AcquiredConns()), nil })
	AddGauge("db.connections.idle", func(context.Context) (float64, error) { return float64(pool.Stat().IdleConns()), nil })
	AddGauge("db.connections.max", func(context.Context) (float64, error) { return float64(pool.Stat().MaxConns()), nil })
	AddGauge("db.waits", func(context.Context) (float64, error) { return float64(pool.Stat().EmptyAcquireCount()), nil })
}

// bothHandlers sends each log record to two handlers: stderr as before, and OpenTelemetry.
type bothHandlers [2]slog.Handler

func (b bothHandlers) Enabled(ctx context.Context, l slog.Level) bool {
	return b[0].Enabled(ctx, l) || b[1].Enabled(ctx, l)
}

func (b bothHandlers) Handle(ctx context.Context, r slog.Record) error {
	return errors.Join(b[0].Handle(ctx, r.Clone()), b[1].Handle(ctx, r))
}

func (b bothHandlers) WithAttrs(as []slog.Attr) slog.Handler {
	return bothHandlers{b[0].WithAttrs(as), b[1].WithAttrs(as)}
}

func (b bothHandlers) WithGroup(name string) slog.Handler {
	return bothHandlers{b[0].WithGroup(name), b[1].WithGroup(name)}
}

// TraceID is the trace ctx belongs to, "" outside one.
func TraceID(ctx context.Context) string {
	if sc := trace.SpanContextFromContext(ctx); sc.HasTraceID() {
		return sc.TraceID().String()
	}
	return ""
}

// Observe traces every request to h (otelhttp), named by mux's route pattern (never the raw path, which may hold
// tokens), and answers with X-Request-Id: the trace ID, to quote to support. A W3C traceparent continues its trace.
// RouteSeen, when set (the end-to-end suite), hears the mux pattern of every request, so the suite can tell which
// public routes it never reached.
var RouteSeen func(pattern string)

func Observe(mux *http.ServeMux, h http.Handler) http.Handler {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if RouteSeen != nil {
			_, pattern := mux.Handler(r)
			RouteSeen(pattern)
		}
		if id := TraceID(r.Context()); id != "" {
			w.Header().Set("X-Request-Id", id)
		}
		h.ServeHTTP(w, r)
	})
	return otelhttp.NewHandler(inner, "ulka-api", otelhttp.WithSpanNameFormatter(func(_ string, r *http.Request) string {
		if _, pattern := mux.Handler(r); pattern != "" {
			return pattern
		}
		return r.Method + " (no route)"
	}))
}

// setTenant records which workspace the current request or job worked for, and the Ulka admin behind it if any.
func setTenant(ctx context.Context, p Principal) {
	span := trace.SpanFromContext(ctx)
	if !span.IsRecording() || !p.TenantID.Valid {
		return
	}
	span.SetAttributes(attribute.String("ulka.tenant_id", p.TenantID.String()))
	if p.Acting != nil {
		span.SetAttributes(attribute.String("ulka.acting_admin", p.Acting.AdminName))
	}
}

// dbTracer records database queries inside a trace, named by their sqlc query name. Quick ones (under a
// millisecond) are left out: they are most queries, and rarely the question.
type dbTracer struct{}

type queryKey struct{}

type queryStart struct {
	sql   string
	start time.Time
}

var queryName = regexp.MustCompile(`--\s*name:\s*(\w+)`)

func (dbTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if !trace.SpanFromContext(ctx).IsRecording() {
		return ctx
	}
	return context.WithValue(ctx, queryKey{}, queryStart{data.SQL, time.Now()})
}

func (dbTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	q, ok := ctx.Value(queryKey{}).(queryStart)
	err := data.Err
	if errors.Is(err, pgx.ErrNoRows) {
		err = nil // a lookup that finds nothing isn't a failure
	}
	if !ok || (time.Since(q.start) < time.Millisecond && err == nil) {
		return
	}
	name := "query"
	if m := queryName.FindStringSubmatch(q.sql); m != nil {
		name = m[1]
	} else if f := strings.Fields(q.sql); len(f) > 0 {
		name = strings.ToUpper(f[0]) // raw SQL: its verb, never its text
	}
	_, span := tracer.Start(ctx, name, trace.WithSpanKind(trace.SpanKindClient), trace.WithTimestamp(q.start),
		trace.WithAttributes(semconv.DBSystemNamePostgreSQL, semconv.DBOperationName(name)))
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
	}
	span.End()
}

// JobMiddleware traces every job run as the root of its own trace, named by kind, with its workspace when the
// arguments carry one. A snoozed job isn't a failure; it's marked ulka.job.snoozed.
type JobMiddleware struct{ river.MiddlewareDefaults }

func (JobMiddleware) Work(ctx context.Context, job *rivertype.JobRow, doInner func(context.Context) error) error {
	ctx, span := tracer.Start(ctx, job.Kind, trace.WithNewRoot(), trace.WithSpanKind(trace.SpanKindConsumer), trace.WithAttributes(
		attribute.String("messaging.system", "river"), attribute.String("ulka.job.queue", job.Queue), attribute.Int("ulka.job.attempt", job.Attempt)))
	defer span.End()
	var args struct {
		TenantID pgtype.UUID `json:"tenant_id"`
	}
	if json.Unmarshal(job.EncodedArgs, &args) == nil {
		setTenant(ctx, Principal{TenantID: args.TenantID})
	}
	err := runJob(ctx, job, doInner)
	var snooze *river.JobSnoozeError
	switch {
	case errors.As(err, &snooze):
		span.SetAttributes(attribute.Bool("ulka.job.snoozed", true))
	case err != nil:
		span.SetStatus(codes.Error, err.Error()) // already a plain sentence: runJob logged the raw error
	}
	return err
}

// runJob keeps raw text out of what River stores (the admin Jobs pages show it): the raw error and any panic go to
// the log, and the job fails with the plain sentence. Cancelling and snoozing keep their meaning.
func runJob(ctx context.Context, job *rivertype.JobRow, doInner func(context.Context) error) (err error) {
	defer func() {
		if v := recover(); v != nil {
			slog.ErrorContext(ctx, "job panicked", "job", job.ID, "kind", job.Kind, "panic", v, "stack", string(debug.Stack()))
			err = errors.New(FailOurs)
		}
	}()
	err = doInner(ctx)
	var snooze *river.JobSnoozeError
	var cancel *river.JobCancelError
	switch {
	case err == nil, errors.As(err, &snooze):
		return err
	case errors.As(err, &cancel):
		slog.ErrorContext(ctx, "job cancelled", "job", job.ID, "kind", job.Kind, "err", err)
		return river.JobCancel(errors.New(PlainFailure(err)))
	}
	slog.ErrorContext(ctx, "job failed", "job", job.ID, "kind", job.Kind, "attempt", job.Attempt, "err", err)
	return errors.New(PlainFailure(err))
}
