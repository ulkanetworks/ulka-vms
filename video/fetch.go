package video

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/riverqueue/river"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/transcoder"
)

// FetchArgs imports a video from a URL: the worker downloads it to where an upload would land, then probes it.
type FetchArgs struct {
	AssetRef
	URL string `json:"url"`
}

func (FetchArgs) Kind() string { return "fetch_input" }

func (FetchArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: "standard", MaxAttempts: 3}
}

// validInputURL accepts an http(s) address with a public host and no credentials. The fetch itself refuses
// private addresses when it connects, so a name that later resolves inward is still stopped.
func validInputURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || len(raw) > core.MaxURL {
		return false
	}
	if a, err := netip.ParseAddr(u.Hostname()); err == nil {
		return core.PublicIP(a)
	}
	return core.ValidHostname(strings.ToLower(u.Hostname()))
}

func newAssetID() pgtype.UUID {
	var b [16]byte
	rand.Read(b[:])
	b[6], b[8] = b[6]&0x0f|0x40, b[8]&0x3f|0x80 // version 4, RFC 4122 variant
	return pgtype.UUID{Bytes: b, Valid: true}
}

// FetchClient follows a few redirects (signed storage links often redirect); every hop dials through the
// public-only check, so a redirect can't reach our own network. Tests replace it.
var FetchClient = func() *http.Client {
	c := core.PublicClient(0) // bounded by the job's timeout, not the client's: large files take a while
	c.CheckRedirect = func(_ *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		return nil
	}
	return c
}()

type fetchWorker struct {
	river.WorkerDefaults[FetchArgs]
	*module
}

func (w *fetchWorker) Work(ctx context.Context, job *river.Job[FetchArgs]) error {
	ref := job.Args.AssetRef
	code, err := w.fetch(ctx, ref, job.Args.URL)
	if err != nil {
		return w.retryOrFail(ctx, job.JobRow, ref, "input_unreachable", err)
	}
	if code != "" {
		return w.fail(ctx, ref, code)
	}
	return inTenant(ctx, w.Pool, ref.TenantID, func(q tx) error {
		if _, err := q.StartAssetIfWaiting(ctx, ref.AssetID); errors.Is(err, pgx.ErrNoRows) {
			return nil // deleted while downloading
		} else if err != nil {
			return err
		}
		return transcoder.Start(ctx, w.River, q.TenantTx, ref)
	})
}

// fetch downloads the source, within the workspace's upload size. It returns a code for a source we refuse
// (it won't get better on retry) or an error worth retrying.
func (w *fetchWorker) fetch(ctx context.Context, ref AssetRef, rawURL string) (string, error) {
	var limit int64
	err := inTenant(ctx, w.Pool, ref.TenantID, func(q tx) error {
		if n, err := q.StartJob(ctx, ref.JobID); err != nil {
			return err
		} else if n == 1 {
			if err := EmitJob(ctx, river.ClientFromContext[pgx.Tx](ctx), q, "job.started", ref.JobID); err != nil {
				return err
			}
		}
		limits, err := core.LimitsFor(ctx, q.TenantTx)
		limit = limits.MaxUploadBytes
		return err
	})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return "input_unreachable", nil
	}
	res, err := FetchClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	switch {
	case res.StatusCode >= 500 || res.StatusCode == http.StatusTooManyRequests:
		return "", fmt.Errorf("input answered HTTP %d", res.StatusCode)
	case res.StatusCode != http.StatusOK:
		return "input_unreachable", nil // missing or forbidden: retrying won't change it
	case res.ContentLength > limit:
		return core.ErrUploadTooLarge.Code, nil
	}
	f, err := os.CreateTemp("", "import")
	if err != nil {
		return "", err
	}
	defer core.RemoveTemp(f.Name())
	n, err := io.Copy(f, io.LimitReader(res.Body, limit+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", err
	}
	if n > limit {
		return core.ErrUploadTooLarge.Code, nil
	}
	return "", w.Store.PutFile(ctx, SourceKey(ref.TenantID, ref.AssetID), f.Name())
}
