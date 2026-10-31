package video

import (
	"context"
	"crypto/rand"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/migrations"
)

func TestUploadLock(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Fatal("TEST_DATABASE_URL is not set")
	}
	if err := core.Migrate(t.Context(), os.Getenv("TEST_OWNER_DATABASE_URL"), core.Migrations{FS: migrations.FS}); err != nil {
		t.Fatal(err)
	}
	pool, err := core.Connect(t.Context(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	lockLease, lockRenew, lockPoll = 2*time.Second, 200*time.Millisecond, 50*time.Millisecond
	id := rand.Text()

	// A second request asks the holder to let go, and gets the lock once it does.
	first := uploadLock(pool, id)
	var asked atomic.Bool
	if err := first.Lock(t.Context(), func() { asked.Store(true) }); err != nil {
		t.Fatal(err)
	}
	second := uploadLock(pool, id)
	got := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		got <- second.Lock(ctx, func() {})
	}()
	deadline := time.Now().Add(3 * time.Second)
	for !asked.Load() && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if !asked.Load() {
		t.Fatal("the holder was never asked to let go")
	}
	select {
	case <-got:
		t.Fatal("second took the lock while the first still held it")
	default:
	}
	first.Unlock()
	if err := <-got; err != nil {
		t.Fatalf("second: %v", err)
	}

	// A holder that dies stops renewing; its lease lapses and the next request takes over.
	dead := second
	close(dead.stop)
	dead.done.Wait()
	dead.stop = nil // it never unlocks: the node is gone
	third := uploadLock(pool, id)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := time.Now()
	if err := third.Lock(ctx, func() {}); err != nil {
		t.Fatalf("after the lease lapsed: %v", err)
	}
	if time.Since(start) < time.Second {
		t.Fatal("took over a live lease")
	}
	third.Unlock()
}
