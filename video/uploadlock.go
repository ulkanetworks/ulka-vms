package video

import (
	"context"
	"crypto/rand"
	"errors"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Lease timings: a held lock is renewed every lockRenew and lapses lockLease after its last renewal.
var (
	lockLease = 30 * time.Second
	lockRenew = 10 * time.Second
	lockPoll  = 250 * time.Millisecond
)

var errLockTimeout = errors.New("upload is locked by another request")

// uploadLock keeps two requests from writing one upload at once, across API nodes, as a lease in Postgres.
func uploadLock(pool *pgxpool.Pool, id string) *pgLock { return &pgLock{pool: pool, id: id} }

type pgLock struct {
	pool   *pgxpool.Pool
	id     string
	holder string
	stop   chan struct{}
	done   sync.WaitGroup
}

// Lock takes the lease, or waits for it: a waiter asks the holder to let go, and a lapsed lease is taken over.
func (l *pgLock) Lock(ctx context.Context, requestUnlock func()) error {
	l.holder = rand.Text()
	for {
		var got string
		err := l.pool.QueryRow(ctx, `INSERT INTO upload_locks (upload_id, holder, expires_at) VALUES ($1, $2, now() + $3::interval)
			ON CONFLICT (upload_id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at, release_requested = false
			WHERE upload_locks.expires_at < now() RETURNING holder`, l.id, l.holder, lockLease.String()).Scan(&got)
		if err == nil {
			break
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if _, err := l.pool.Exec(ctx, "UPDATE upload_locks SET release_requested = true WHERE upload_id = $1", l.id); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return errLockTimeout
		case <-time.After(lockPoll):
		}
	}
	l.stop = make(chan struct{})
	l.done.Add(1)
	go l.renew(requestUnlock)
	return nil
}

// renew keeps the lease alive, and passes on the first request from a waiter to let go.
func (l *pgLock) renew(requestUnlock func()) {
	defer l.done.Done()
	asked := false
	for {
		select {
		case <-l.stop:
			return
		case <-time.After(lockRenew):
		}
		var release bool
		err := l.pool.QueryRow(context.Background(), `UPDATE upload_locks SET expires_at = now() + $3::interval
			WHERE upload_id = $1 AND holder = $2 RETURNING release_requested`, l.id, l.holder, lockLease.String()).Scan(&release)
		if (err == nil && release || errors.Is(err, pgx.ErrNoRows)) && !asked {
			asked = true // someone is waiting, or the lease was lost: finish up quickly
			requestUnlock()
		}
	}
}

func (l *pgLock) Unlock() error {
	if l.stop != nil {
		close(l.stop)
		l.done.Wait()
	}
	_, err := l.pool.Exec(context.Background(), "DELETE FROM upload_locks WHERE upload_id = $1 AND holder = $2", l.id, l.holder)
	return err
}
