package video

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/transcoder"
	"github.com/ulkanetworks/ulka-vms/video/db"
)

// CheckClient fetches from Ulka's own hosts for the playback check; tests replace it.
var CheckClient = &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

// playStep is one part of playing a video the way a viewer's player does, and whether it worked.
type playStep struct {
	Kind    string `json:"kind"` // settings, playlist, quality, backup (the same quality from the origin), subtitles
	Name    string `json:"name"`
	URL     string `json:"url"` // without the signature
	OK      bool   `json:"ok"`
	Millis  int64  `json:"ms"`
	Message string `json:"message"`
}

var mediaName = regexp.MustCompile(`NAME="([^"]*)"`)

// playChecker fetches like a browser on another website would (an Origin header), so CORS problems show.
type playChecker struct {
	s               *module
	origin          string
	keys            map[string][]byte // each key fetched once
	code            string            // the error code of the last refused answer from Ulka
	ctx             context.Context
	trusted, public *http.Client
}

// get fetches u; problem is a plain sentence when it didn't answer properly.
func (c *playChecker) get(u string) (body []byte, problem string) {
	req, err := http.NewRequestWithContext(c.ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, "The address isn't valid."
	}
	req.Header.Set("Origin", c.origin)
	// Ulka's own hosts may be on a private network; anything else (a customer's own CDN) must be public.
	client := c.public
	if strings.HasPrefix(u, c.s.PlayerURL+"/") || strings.HasPrefix(u, c.s.OriginURL+"/") {
		client = c.trusted
	}
	resp, err := client.Do(req)
	if err != nil {
		core.LogFailure(c.ctx, err, "playback check fetch failed", "host", req.URL.Host)
		return nil, "No answer from " + req.URL.Host + "."
	}
	defer func() { _ = resp.Body.Close() }()
	body, err = io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, "The answer from " + req.URL.Host + " broke off."
	}
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error struct{ Code, Message string } `json:"error"`
		}
		if json.Unmarshal(body, &e) == nil && e.Error.Message != "" {
			c.code = e.Error.Code
			return nil, e.Error.Message
		}
		return nil, req.URL.Host + " answered " + strconv.Itoa(resp.StatusCode) + " (" + strings.ToLower(http.StatusText(resp.StatusCode)) + ")."
	}
	switch allow := resp.Header.Values("Access-Control-Allow-Origin"); {
	case len(allow) == 0:
		return nil, "Browsers would refuse it: " + req.URL.Host + " doesn't let other websites use the file (no Access-Control-Allow-Origin header)."
	case len(allow) > 1:
		return nil, "Browsers would refuse it: " + req.URL.Host + " sends Access-Control-Allow-Origin twice. Only one may be sent."
	case allow[0] != "*" && allow[0] != c.origin:
		return nil, "Browsers would refuse it: " + req.URL.Host + " lets only " + allow[0] + " use the file."
	}
	return body, ""
}

// rendition fetches a quality's list, its key, its start and its first piece, and decrypts the piece.
func (c *playChecker) rendition(u string) string {
	list, problem := c.get(u)
	if problem != "" {
		return problem
	}
	segment, _, iv, err := transcoder.SegmentAt(list, 0)
	keyURI, initURI := tagURI(list, "#EXT-X-KEY:"), tagURI(list, "#EXT-X-MAP:")
	if err != nil || keyURI == "" || initURI == "" {
		return "Its list of pieces is incomplete: the video wasn't packaged properly. Process it again."
	}
	key, ok := c.keys[resolve(u, keyURI)]
	if !ok {
		if key, problem = c.get(resolve(u, keyURI)); problem != "" {
			return "The key to unlock it: " + problem
		}
		c.keys[resolve(u, keyURI)] = key
	}
	init, problem := c.get(resolve(u, initURI))
	if problem != "" {
		return "Its start: " + problem
	}
	piece, problem := c.get(resolve(u, segment))
	if problem != "" {
		return "Its first piece: " + problem
	}
	clear, err := transcoder.DecryptSegment(piece, key, iv)
	if len(key) != 16 || len(init) < 8 || string(init[4:8]) != "ftyp" || err != nil || !bytes.Contains(clear[:min(len(clear), 1024)], []byte("moof")) {
		return "Its first piece doesn't unlock into video: the files are damaged. Process it again."
	}
	return ""
}

// tagURI is the URI="…" of the first line starting with tag.
func tagURI(list []byte, tag string) string {
	for l := range strings.SplitSeq(string(list), "\n") {
		if strings.HasPrefix(l, tag) {
			if m := uriAttr.FindString(l); m != "" {
				return strings.TrimSuffix(strings.TrimPrefix(m, `URI="`), `"`)
			}
		}
	}
	return ""
}

func resolve(base, ref string) string {
	b, err1 := url.Parse(base)
	r, err2 := url.Parse(ref)
	if err1 != nil || err2 != nil {
		return ref
	}
	return b.ResolveReference(r).String()
}

// bare is an address without its signature, to show.
func bare(u string) string {
	p, err := url.Parse(u)
	if err != nil {
		return u
	}
	q := p.Query()
	q.Del("token")
	p.RawQuery = q.Encode()
	return p.String()
}

// playbackCheck plays a video over the network as a player on another website would: its settings, its playlist, then
// for every quality the list, key, start and first piece (decrypted, so a damaged encode shows), and every subtitle.
// A private video is checked with a ten-minute signature from the workspace's newest signing key.
func (s *module) playbackCheck(w http.ResponseWriter, r *http.Request, pr core.Principal) {
	out, err := s.checkPlayback(r.Context(), r.URL.Query().Get("page"), func(fn func(tx, pgtype.UUID) error) error { return withPathID(s.Deps, r, pr, fn) })
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, out)
}

// checkPlayback runs the check; run opens the video's transaction (the caller's scope, or its tenant's for admins).
func (s *module) checkPlayback(ctx context.Context, page string, run func(func(tx, pgtype.UUID) error) error) (map[string]any, error) {
	page = strings.TrimSpace(page)
	if page != "" && !validPage(page) {
		return nil, errInvalidURL
	}
	var asset db.Asset
	var token string
	err := run(func(q tx, id pgtype.UUID) (err error) {
		if asset, err = q.GetAsset(ctx, id); err != nil {
			return err
		}
		if asset.Status != "ready" && asset.Status != "complete" {
			return errNotReady
		}
		if asset.PlaybackPolicy != "signed" {
			return nil
		}
		key, err := q.LatestSigningKey(ctx)
		if errors.Is(err, pgx.ErrNoRows) {
			return errNoSigningKey
		}
		if err != nil {
			return err
		}
		if key.Secret, err = core.Open(s.SealKey, key.Secret); err != nil {
			return err
		}
		acl := "/" + asset.LibraryID.String() + "/" + asset.ID.String() + "/*"
		token = signPath(key.ID.String(), key.Secret, time.Now().Add(10*time.Minute).Unix(), acl, "", "")
		return nil
	})
	if err != nil {
		return nil, err
	}
	c := &playChecker{s: s, origin: s.PublicURL, keys: map[string][]byte{}, ctx: ctx,
		trusted: CheckClient, public: core.PublicClient(15 * time.Second)}
	video := s.PlayerURL + "/" + asset.LibraryID.String() + "/" + asset.ID.String() + "/"
	signed := func(u string) string {
		if token == "" {
			return u
		}
		return u + queryJoin(u) + "token=" + url.QueryEscape(token)
	}
	steps := []playStep{}
	step := func(kind, name, u string, run func() string) {
		start := time.Now()
		problem := run()
		msg := problem
		if msg == "" {
			msg = map[string]string{"settings": "The player gets its settings.", "playlist": "The playlist lists every quality.",
				"subtitles": "The subtitles load.", "quality": "It loads, unlocks and starts.", "backup": "It loads, unlocks and starts."}[kind]
		}
		steps = append(steps, playStep{Kind: kind, Name: name, URL: bare(u), OK: problem == "", Millis: time.Since(start).Milliseconds(), Message: msg})
	}

	config := video + "config.json"
	if page != "" {
		config += "?ref=" + url.QueryEscape(page)
	}
	step("settings", "Player settings", config, func() string {
		if _, p := c.get(signed(config)); p != "" {
			if page == "" && c.code == errDomainNotAllowed.Code {
				return "Its library lets only listed websites show it, so opening the watch page on its own is refused. Enter the page it's embedded on to check that website."
			}
			return p
		}
		return ""
	})
	var master []byte
	step("playlist", "Playlist", video+"playlist.m3u8", func() (p string) { master, p = c.get(signed(video + "playlist.m3u8")); return })
	lines := strings.Split(string(master), "\n")
	seen := map[string]bool{}
	for i, l := range lines {
		var ref, name string
		switch {
		case strings.HasPrefix(l, "#EXT-X-STREAM-INF") && i+1 < len(lines):
			ref = lines[i+1]
		case strings.HasPrefix(l, "#EXT-X-MEDIA:"):
			ref = tagURI([]byte(l), "#EXT-X-MEDIA:")
			if m := mediaName.FindStringSubmatch(l); m != nil {
				name = m[1]
			}
		}
		u := resolve(video+"playlist.m3u8", ref)
		if ref == "" || strings.HasPrefix(ref, "#") || seen[u] {
			continue
		}
		seen[u] = true
		file, _, _ := strings.Cut(ref, "?")
		kind := "quality"
		switch {
		case strings.Contains(l, "TYPE=SUBTITLES"):
			kind = "subtitles"
		case strings.Contains(ref, "via=origin"):
			kind = "backup"
		}
		if name == "" || kind != "subtitles" {
			name = strings.TrimSuffix(file, ".m3u8")
		}
		if kind == "subtitles" {
			step(kind, name, u, func() string {
				list, p := c.get(u)
				if p != "" {
					return p
				}
				vtt, p := c.get(resolve(u, firstMedia(list)))
				if p == "" && !strings.HasPrefix(strings.TrimPrefix(string(vtt), "\ufeff"), "WEBVTT") {
					p = "The subtitle file isn't WebVTT. Add it again."
				}
				return p
			})
			continue
		}
		step(kind, name, u, func() string { return c.rendition(u) })
	}
	return map[string]any{"data": steps, "checked_at": time.Now().UTC()}, nil
}

// firstMedia is a playlist's first address line.
func firstMedia(list []byte) string {
	for l := range strings.SplitSeq(string(list), "\n") {
		if l != "" && !strings.HasPrefix(l, "#") {
			return l
		}
	}
	return ""
}

var errInvalidURL = core.APIError{Status: http.StatusBadRequest, Code: "invalid_url"}

// validPage is a page a player is embedded on, as the checks take it: https, a host, no login or fragment.
func validPage(page string) bool {
	u, err := url.Parse(page)
	return err == nil && u.Scheme == "https" && u.Hostname() != "" && u.User == nil && u.Fragment == "" && len(page) <= core.MaxURL
}
