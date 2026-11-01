// Package origin serves videos' encrypted segments from storage to viewers and CDNs, reading the bucket with this
// server's own storage key, so the bucket itself stays private. Playlists, keys and sources go through the API.
// Each request is a row of origin_access_logs in ClickHouse, where video delivery is metered.
package origin

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/netip"
	"regexp"
	"strconv"
	"time"

	awshttp "github.com/aws/aws-sdk-go-v2/aws/transport/http"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/ulkanetworks/ulka-vms/core"
)

// Only segments and init segments: /s/<workspace>/<video>/<quality>/<file>, the storage key after /s/.
var segmentPath = regexp.MustCompile(`^/s/([0-9a-f-]{36}/[0-9a-f-]{36}/(?:[0-9]+p|audio)/(?:init\.mp4|[0-9]+\.m4s))$`)

// Origin is the handler; Deliveries receives one row per segment request.
type Origin struct {
	Store      core.Storage
	Deliveries *core.ClickHouseLog
	Trusted    []netip.Prefix // proxies whose X-Forwarded-For names the viewer
}

func (o *Origin) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	m := segmentPath.FindStringSubmatch(r.URL.Path)
	if m == nil {
		http.NotFound(w, r)
		return
	}
	start, rec := time.Now(), &recorder{ResponseWriter: w, status: http.StatusOK}
	o.serve(rec, r, m[1])
	o.Deliveries.Add(core.DeliveryRow(r, o.Trusted, r.URL.Path, rec.status, rec.bytes, time.Since(start)))
}

func (o *Origin) serve(w http.ResponseWriter, r *http.Request, key string) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	in := &s3.GetObjectInput{Bucket: &o.Store.Bucket, Key: &key}
	if rng := r.Header.Get("Range"); rng != "" {
		in.Range = &rng
	}
	obj, err := o.Store.S3.GetObject(r.Context(), in)
	var re *awshttp.ResponseError
	switch {
	case err == nil:
	case errors.As(err, &re) && (re.HTTPStatusCode() == http.StatusNotFound || re.HTTPStatusCode() == http.StatusForbidden):
		w.WriteHeader(http.StatusNotFound)
		return
	case errors.As(err, &re) && re.HTTPStatusCode() == http.StatusRequestedRangeNotSatisfiable:
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return
	default:
		if r.Context().Err() == nil {
			slog.ErrorContext(r.Context(), "origin: storage read failed", "key", key, "err", err)
		}
		w.WriteHeader(http.StatusBadGateway)
		return
	}
	defer obj.Body.Close()
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Cache-Control", "public, max-age=31536000") // a segment never changes once written
	h.Set("Accept-Ranges", "bytes")
	set := func(name string, v *string) {
		if v != nil {
			h.Set(name, *v)
		}
	}
	set("Content-Type", obj.ContentType)
	set("ETag", obj.ETag)
	set("Content-Range", obj.ContentRange)
	if obj.ContentLength != nil {
		h.Set("Content-Length", strconv.FormatInt(*obj.ContentLength, 10))
	}
	if obj.LastModified != nil {
		h.Set("Last-Modified", obj.LastModified.UTC().Format(http.TimeFormat))
	}
	status := http.StatusOK
	if obj.ContentRange != nil {
		status = http.StatusPartialContent
	}
	w.WriteHeader(status)
	if r.Method == http.MethodHead {
		return
	}
	if _, err := io.Copy(w, obj.Body); err != nil && r.Context().Err() == nil {
		slog.WarnContext(r.Context(), "origin: segment cut off", "key", key, "err", err)
	}
}

type recorder struct {
	http.ResponseWriter
	status int
	bytes  int64
}

func (r *recorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *recorder) Write(b []byte) (int, error) {
	n, err := r.ResponseWriter.Write(b)
	r.bytes += int64(n)
	return n, err
}
