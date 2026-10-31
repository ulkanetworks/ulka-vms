package video

import (
	"net/http"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ulkanetworks/ulka-vms/core"
)

// PlaybackTTL is how long a ready video's playback facts are kept in memory: a viral video's viewers then cost the
// database one read per video per TTL instead of several per request. Signatures and country rules are still checked
// on every request; a workspace's own changes clear its entries at once (forgetting), others (an admin suspending
// the workspace, a download finishing in the worker, its CDN distribution going live) show within the TTL. Tests shorten it.
var PlaybackTTL = 30 * time.Second

type cachedPlayback struct {
	p       playback // without the viewer's token or watermark
	country Access   // the library's country rule
	at      time.Time
}

type cachedSecret struct {
	secret []byte
	at     time.Time
}

// playbackCache is in this process only, which holds while there is one API machine (.claude/rules/live.md: the hub).
type playbackCache struct {
	mu      sync.Mutex
	videos  map[pgtype.UUID]cachedPlayback
	secrets map[[2]pgtype.UUID]cachedSecret // tenant, signing key
}

func newPlaybackCache() *playbackCache {
	return &playbackCache{videos: map[pgtype.UUID]cachedPlayback{}, secrets: map[[2]pgtype.UUID]cachedSecret{}}
}

// ponytail: cleared whole past maxCached entries, not LRU; fine while bursts are a few hot videos.
const maxCached = 10000

func (c *playbackCache) video(lib, vid pgtype.UUID) (cachedPlayback, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.videos[vid]
	if !ok || time.Since(v.at) > PlaybackTTL || v.p.libraryID != lib.String() {
		return cachedPlayback{}, false
	}
	return v, true
}

func (c *playbackCache) putVideo(v cachedPlayback) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.videos) >= maxCached {
		clear(c.videos)
	}
	v.at = time.Now()
	c.videos[v.p.assetID] = v
}

func (c *playbackCache) secret(tenant, kid pgtype.UUID) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	s, ok := c.secrets[[2]pgtype.UUID{tenant, kid}]
	return s.secret, ok && time.Since(s.at) <= PlaybackTTL
}

func (c *playbackCache) putSecret(tenant, kid pgtype.UUID, secret []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.secrets) >= maxCached {
		clear(c.secrets)
	}
	c.secrets[[2]pgtype.UUID{tenant, kid}] = cachedSecret{secret, time.Now()}
}

// forgetTenant drops everything kept for a workspace.
func (c *playbackCache) forgetTenant(tenant pgtype.UUID) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for id, v := range c.videos {
		if v.p.tenantID == tenant {
			delete(c.videos, id)
		}
	}
	for k := range c.secrets {
		if k[0] == tenant {
			delete(c.secrets, k)
		}
	}
}

// forgetting wraps a handler that changes a workspace's videos, libraries, keys or delivery: once it has run, the
// workspace's cached playback is dropped, so privacy, trash, country and key changes apply to the next request.
func (s *module) forgetting(h func(http.ResponseWriter, *http.Request, core.Principal)) func(http.ResponseWriter, *http.Request, core.Principal) {
	return func(w http.ResponseWriter, r *http.Request, p core.Principal) {
		defer s.cache.forgetTenant(p.TenantID)
		h(w, r, p)
	}
}
