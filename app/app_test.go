package app

import (
	"runtime"
	"testing"

	"github.com/ulkanetworks/ulka-vms/transcoder"
)

func TestParseQueues(t *testing.T) {
	q, err := ParseQueues(" interactive=8, webhooks=40", Queues)
	if err != nil || len(q) != 2 || q["interactive"].MaxWorkers != 8 || q["webhooks"].MaxWorkers != 40 {
		t.Fatalf("got %v, %v", q, err)
	}
	if q, err := ParseQueues("none", Queues); err != nil || len(q) != 0 {
		t.Fatalf("none: %v, %v", q, err)
	}
	for _, bad := range []string{"", "encode=4", "standard=auto", "interactive", "interactive=0", "interactive=x", "interactive=4,"} {
		if _, err := ParseQueues(bad, Queues); err == nil {
			t.Errorf("%q: want an error", bad)
		}
	}
}

func TestParseEncodeSlots(t *testing.T) {
	// "auto" is one piece per EncodeThreads cores, never fewer than one.
	if n, err := ParseEncodeSlots("auto"); err != nil || n != max(1, runtime.NumCPU()/transcoder.EncodeThreads) {
		t.Fatalf("auto: %d, %v", n, err)
	}
	if n, err := ParseEncodeSlots("0"); err != nil || n != 0 {
		t.Fatalf("0: %d, %v", n, err)
	}
	for _, bad := range []string{"", "-1", "x", "1001"} {
		if _, err := ParseEncodeSlots(bad); err == nil {
			t.Errorf("%q: want an error", bad)
		}
	}
}
