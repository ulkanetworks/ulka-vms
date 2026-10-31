package webhooks

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
)

func TestPublicAddr(t *testing.T) {
	for addr, want := range map[string]bool{
		"8.8.8.8:443": true, "[2606:4700::1111]:443": true,
		"127.0.0.1:443": false, "10.1.2.3:443": false, "192.168.1.1:443": false, "172.16.0.1:443": false,
		"169.254.169.254:80": false, "100.64.0.1:443": false, "[::1]:443": false, "[::ffff:127.0.0.1]:443": false,
		"[fe80::1]:443": false, "0.0.0.0:443": false, "not-an-address": false,
	} {
		if publicAddr(addr) != want {
			t.Errorf("publicAddr(%s) = %v", addr, !want)
		}
	}
	_, err := WebhookClient.Get("https://127.0.0.1:1/")
	if err == nil || !strings.Contains(err.Error(), "not a public address") {
		t.Fatalf("loopback webhook not refused: %v", err)
	}
}

func TestWebhookRetrySchedule(t *testing.T) {
	w := &deliverWorker{}
	for attempt, want := range map[int]time.Duration{1: 10 * time.Second, 2: 20 * time.Second, 5: 160 * time.Second, 10: time.Hour, 60: time.Hour} {
		got := time.Until(w.NextRetry(&river.Job[DeliverArgs]{JobRow: &rivertype.JobRow{Attempt: attempt}}))
		if got < want-time.Second || got > want {
			t.Errorf("attempt %d retries in %s, want %s", attempt, got, want)
		}
	}
	old := &river.Job[DeliverArgs]{JobRow: &rivertype.JobRow{CreatedAt: time.Now().Add(-25 * time.Hour)}}
	var cancel *rivertype.JobCancelError
	if err := w.Work(t.Context(), old); !errors.As(err, &cancel) {
		t.Fatalf("a 25 h old delivery should be cancelled, got %v", err)
	}
}
