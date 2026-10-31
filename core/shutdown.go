package core

import "sync"

var (
	closing   = make(chan struct{})
	closeOnce sync.Once
)

// Closing is closed when the process starts shutting down, so a long wait (a Live Server's poll) ends at once
// instead of holding the restart up for its whole length.
func Closing() <-chan struct{} { return closing }

// BeginShutdown closes Closing; the API calls it before it stops accepting requests.
func BeginShutdown() { closeOnce.Do(func() { close(closing) }) }
