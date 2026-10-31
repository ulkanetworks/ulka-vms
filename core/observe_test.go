package core

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func attr(s sdktrace.ReadOnlySpan, key string) string {
	for _, a := range s.Attributes() {
		if string(a.Key) == key {
			return a.Value.Emit()
		}
	}
	return ""
}

// Requests are traced by route pattern with their workspace, answer with X-Request-Id, and job runs are roots that
// record failures but not snoozes.
func TestObserve(t *testing.T) {
	rec := tracetest.NewSpanRecorder()
	saved := otel.GetTracerProvider()
	otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(rec)))
	tracer = otel.Tracer(instrumentation)
	t.Cleanup(func() { otel.SetTracerProvider(saved) })

	tenant := pgtype.UUID{Bytes: [16]byte{1}, Valid: true}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/things/{id}", func(w http.ResponseWriter, r *http.Request) {
		setTenant(r.Context(), Principal{TenantID: tenant})
		w.WriteHeader(http.StatusTeapot)
	})
	res := httptest.NewRecorder()
	Observe(mux, mux).ServeHTTP(res, httptest.NewRequest("GET", "/v1/things/secret-token-123", nil))

	spans := rec.Ended()
	if len(spans) != 1 {
		t.Fatalf("%d spans", len(spans))
	}
	s := spans[0]
	if s.Name() != "GET /v1/things/{id}" || attr(s, "ulka.tenant_id") != tenant.String() || attr(s, "http.response.status_code") != "418" {
		t.Fatalf("request span %q: %v", s.Name(), s.Attributes())
	}
	if res.Header().Get("X-Request-Id") != s.SpanContext().TraceID().String() {
		t.Fatalf("X-Request-Id %q, trace %s", res.Header().Get("X-Request-Id"), s.SpanContext().TraceID())
	}

	job := &rivertype.JobRow{Kind: "cdn_reconcile", Queue: "cdn", Attempt: 2, EncodedArgs: []byte(`{"tenant_id":"` + tenant.String() + `"}`)}
	(JobMiddleware{}).Work(context.Background(), job, func(context.Context) error { return errors.New("edge unreachable") })
	(JobMiddleware{}).Work(context.Background(), job, func(context.Context) error { return river.JobSnooze(time.Second) })
	failed, snoozed := rec.Ended()[1], rec.Ended()[2]
	if failed.Name() != "cdn_reconcile" || failed.Status().Code != codes.Error || attr(failed, "ulka.tenant_id") != tenant.String() {
		t.Fatalf("failed job: %v %v", failed.Status(), failed.Attributes())
	}
	if snoozed.Status().Code == codes.Error || !snoozedAttr(snoozed) {
		t.Fatalf("snoozed job: %v %v", snoozed.Status(), snoozed.Attributes())
	}
}

func snoozedAttr(s sdktrace.ReadOnlySpan) bool {
	for _, a := range s.Attributes() {
		if a.Key == "ulka.job.snoozed" && a.Value == attribute.BoolValue(true) {
			return true
		}
	}
	return false
}
