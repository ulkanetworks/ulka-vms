package core

import (
	"context"
	"time"
)

// KeyStore holds videos' encryption keys outside ulka-vms, in a key service that hands them to players. Without
// one (Deps.Keys nil) each video's key is sealed in the database and served by the player host.
type KeyStore interface {
	// Create returns the video's key, made on first call; asking again returns the same one.
	Create(ctx context.Context, contentID string) (key, iv []byte, err error)
	Get(ctx context.Context, contentID string) (key, iv []byte, err error)
	// Delete forgets a video's key; one already gone is not an error.
	Delete(ctx context.Context, contentID string) error
	// PlayerURL is where a player fetches the video's key, valid until exp.
	PlayerURL(contentID string, exp time.Time) string
}
