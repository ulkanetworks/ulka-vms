package core

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"
)

// ClickHouseLog appends rows to one ClickHouse table in batches, off the request path: a write per request would
// queue every request behind one row. Rows are usage (image transforms, downloads), so the log is drained when the
// process stops (DrainLogs); a crash still loses up to a second of rows.
// ponytail: memory only; a disk spool closes the crash gap when these rows are invoiced.
type ClickHouseLog struct {
	url, table string
	rows       chan []byte
	done       chan struct{}
}

const logBuffer = 10_000

var (
	logsMu sync.Mutex
	logs   []*ClickHouseLog
)

func NewClickHouseLog(url, table string) *ClickHouseLog {
	l := &ClickHouseLog{url: url, table: table, rows: make(chan []byte, logBuffer), done: make(chan struct{})}
	logsMu.Lock()
	logs = append(logs, l)
	logsMu.Unlock()
	go l.run()
	return l
}

// Add never blocks: with ClickHouse unreachable long enough to fill the buffer, rows are dropped and logged.
func (l *ClickHouseLog) Add(row any) {
	line, err := json.Marshal(row)
	if err != nil {
		slog.Error("usage row not encoded", "table", l.table, "err", err)
		return
	}
	select {
	case l.rows <- line:
	default:
		slog.Error("usage dropped: buffer full", "table", l.table)
	}
}

func (l *ClickHouseLog) run() {
	defer close(l.done)
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	var batch [][]byte
	for {
		closing := false
		select {
		case line := <-l.rows:
			if batch = append(batch, line); len(batch) < 1000 {
				continue
			}
		case <-tick.C:
		case <-Closing():
			closing = true
			for len(l.rows) > 0 { // what arrived since the last tick
				batch = append(batch, <-l.rows)
			}
		}
		if len(batch) > 0 {
			if err := l.flush(batch); err != nil {
				slog.Error("usage not sent; retrying", "table", l.table, "rows", len(batch), "err", err)
				if len(batch) >= logBuffer || closing {
					slog.Error("usage dropped", "table", l.table, "rows", len(batch))
					batch = nil
				}
			} else {
				batch = nil
			}
		}
		if closing {
			return
		}
	}
}

func (l *ClickHouseLog) flush(batch [][]byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return ClickHouseInsert(ctx, l.url, l.table, bytes.NewReader(bytes.Join(append(batch, nil), []byte("\n"))))
}

// DrainLogs waits, after BeginShutdown, until every log has sent what it held, or ctx ends.
func DrainLogs(ctx context.Context) {
	logsMu.Lock()
	all := append([]*ClickHouseLog(nil), logs...)
	logsMu.Unlock()
	for _, l := range all {
		select {
		case <-l.done:
		case <-ctx.Done():
			slog.Error("usage not drained before exit", "table", l.table)
			return
		}
	}
}
