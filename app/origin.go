package app

import (
	"context"
	"log/slog"
	"net/http"
	"net/netip"
	"time"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/origin"
)

// ServeOrigin serves videos' segments from storage on addr until ctx ends; each response is metered in ClickHouse.
func ServeOrigin(ctx context.Context, addr string, store core.Storage, clickHouseURL string, trusted []netip.Prefix) error {
	h := &origin.Origin{Store: store, Deliveries: core.NewClickHouseLog(clickHouseURL, "origin_access_logs"), Trusted: trusted}
	srv := &http.Server{Addr: addr, Handler: h, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	slog.Info("origin listening", "addr", addr)
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	core.BeginShutdown()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	err := srv.Shutdown(shutdownCtx)
	core.DrainLogs(shutdownCtx)
	return err
}
