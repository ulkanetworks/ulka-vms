package video

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ulkanetworks/ulka-vms/core"
	"github.com/ulkanetworks/ulka-vms/transcoder"
	"github.com/ulkanetworks/ulka-vms/video/db"
)

var (
	renditionName = regexp.MustCompile(`^(\d+p|audio)$`)
	uriAttr       = regexp.MustCompile(`URI="[^"]*"`)

	errTokenRequired = core.APIError{Status: http.StatusForbidden, Code: "token_required"}
	errTokenInvalid  = core.APIError{Status: http.StatusForbidden, Code: "token_invalid"}
	errTokenExpired  = core.APIError{Status: http.StatusForbidden, Code: "token_expired"}
	errNotReady      = core.APIError{Status: http.StatusNotFound, Code: "asset_not_ready"}
)

// playback is what a viewer's request resolved to.
type playback struct {
	libraryID, videoID string
	tenantID, assetID  pgtype.UUID
	policy             string
	watermark          string // from a verified signature's wm: shown over the video, viewers can't change it
	key                []byte
	keyInService       bool // the key is in the key service (core.KeyStore): players fetch it there, never from /key
	status             string
	plan               transcoder.Plan
	duration           float64
	segmentBase        string             // origin, Ulka CDN or the tenant's CDN
	download, name     string             // the MP4 download's state, and the video's reference for its file name
	token              string             // the verified signature, carried on to every link a playlist gives
	posterTime         pgtype.Float8      // the frame chosen as the cover, if any
	posterUploaded     pgtype.Timestamptz // when a picture was uploaded as the cover, if one was
}

// link adds the viewer's signature to a file's address beside the video, so a private video's playlists keep working.
func (p playback) link(uri string) string {
	if p.token == "" {
		return uri
	}
	path, frag, hasFrag := strings.Cut(uri, "#")
	out := path + queryJoin(path) + "token=" + url.QueryEscape(p.token)
	if hasFrag {
		out += "#" + frag
	}
	return out
}

// tokens are the ways the signature may be written in ?token=: as signed, or URL-encoded once more.
func tokens(r *http.Request) []string { return tokensIn(r.URL.RawQuery) }

func tokensIn(rawQuery string) []string {
	var out []string
	for _, kv := range strings.Split(rawQuery, "&") {
		if v, ok := strings.CutPrefix(kv, "token="); ok {
			out = append(out, v)
		}
	}
	q, _ := url.ParseQuery(rawQuery) // as r.URL.Query(): bad pairs are skipped
	if d := q.Get("token"); d != "" && (len(out) == 0 || d != out[0]) {
		out = append(out, d)
	}
	return out
}

func (p playback) prefix() string { return p.tenantID.String() + "/" + p.assetID.String() + "/" }

// play serves the player host, mapped under /play/ by Caddy (and the dev proxy):
// [/<signature>]/{library}/{video}/{file}. Everything a video needs sits under its own address, so playlists hold
// only relative links and one signature covers the playlists, key, captions, images and config beneath it.
func (s *module) play(w http.ResponseWriter, r *http.Request) {
	playbackHeaders(w)
	lib, vid, file, ok := playParts(r)
	if !ok {
		core.WriteError(w, http.StatusNotFound, "not_found")
		return
	}
	if file == "check.json" {
		s.checkInfo(w, r, lib, vid)
		return
	}
	// Starting playback (the master playlist, the player's config, the download) needs a link that hasn't expired.
	start := file == "playlist.m3u8" || file == "config.json" || file == "download.mp4"
	p, err := s.authorize(r, lib, vid, tokens(r), "/"+lib.String()+"/"+vid.String()+"/"+file, file != "config.json", start)
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	name, isPlaylist := strings.CutSuffix(file, ".m3u8")
	captionID, isCaptionTrack := strings.CutPrefix(name, "captions_")
	switch {
	case file == "config.json" && s.player.Config != nil:
		v, err := s.viewing(r, p)
		if err != nil {
			core.RespondError(w, r, err)
			return
		}
		s.player.Config(w, r, v)
	case file == "playlist.m3u8":
		s.masterPlaylist(w, r, p)
	case isPlaylist && isCaptionTrack:
		s.captionTrack(w, r, p, captionID)
	case isPlaylist && renditionName.MatchString(name):
		s.renditionPlaylist(w, r, p, name)
	case file == "key" && !p.keyInService:
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write(p.key)
	case strings.HasPrefix(file, "captions/"):
		s.captionFile(w, r, p, strings.TrimPrefix(file, "captions/"))
	case file == "download.mp4":
		s.serveDownload(w, r, p)
	default:
		s.image(w, r, p, file)
	}
}

// playParts reads /play/{library}/{video}/{file}.
func playParts(r *http.Request) (lib, vid pgtype.UUID, file string, ok bool) {
	parts := strings.Split(strings.TrimPrefix(r.URL.EscapedPath(), "/play/"), "/")
	if len(parts) < 3 || lib.Scan(parts[0]) != nil || vid.Scan(parts[1]) != nil {
		return lib, vid, "", false
	}
	file, err := url.PathUnescape(strings.Join(parts[2:], "/"))
	return lib, vid, file, err == nil
}

// authorize resolves a library and video; for a signed video it checks the signature covers path. media also needs
// the video ready, with its key and plan; the player's config answers for one still processing.
// gracePastExpiry is how long after a signature expires a session it started may go on fetching qualities, the key,
// captions and pictures: the video's length plus this. Starting again always needs a link that hasn't expired.
const gracePastExpiry = time.Hour

func (s *module) authorize(r *http.Request, lib, vid pgtype.UUID, sigs []string, path string, media, start bool) (playback, error) {
	ctx := r.Context()
	c, err := s.resolve(ctx, lib, vid)
	if err != nil {
		return playback{}, err
	}
	p := c.p
	var expires int64 // the verified signature's expiry, checked once the video's length is known
	if p.policy == "signed" || len(sigs) > 0 {
		err = errTokenRequired
		for _, sig := range sigs {
			var t signature
			if t, err = s.verifySignature(ctx, p.tenantID, sig, path, core.ClientIP(r, s.TrustedProxies)); err == nil {
				p.watermark, p.token, expires = t.watermark, sig, t.exp
				break
			}
		}
		if err != nil {
			return playback{}, err
		}
	}
	// The country rule holds for the stream itself, not only the player, so a copied address doesn't skip it.
	if err := c.country.CountryAllowed(s.Geo, core.ClientIP(r, s.TrustedProxies)); err != nil {
		return playback{}, err
	}
	if media && p.key == nil {
		return playback{}, errNotReady
	}
	if p.token != "" {
		until := time.Unix(expires, 0)
		if !start {
			until = until.Add(time.Duration(p.duration*float64(time.Second)) + gracePastExpiry)
		}
		if !time.Now().Before(until) {
			return playback{}, errTokenExpired
		}
	}
	return p, nil
}

// resolve reads what serving a video needs: from memory for a ready video read in the last PlaybackTTL, else from
// the database (and then kept, once it is ready).
func (s *module) resolve(ctx context.Context, lib, vid pgtype.UUID) (cachedPlayback, error) {
	if c, ok := s.cache.video(lib, vid); ok {
		return c, nil
	}
	row, err := db.New(s.Pool).VideoLookup(ctx, db.VideoLookupParams{LibraryID: lib, VideoID: vid})
	if errors.Is(err, pgx.ErrNoRows) {
		return cachedPlayback{}, errNotFound
	}
	if err != nil {
		return cachedPlayback{}, err
	}
	c := cachedPlayback{p: playback{libraryID: lib.String(), videoID: vid.String(), tenantID: row.TenantID, assetID: vid, policy: row.Policy}}
	err = inTenant(ctx, s.Pool, c.p.tenantID, func(q tx) error {
		l, err := q.PlayerLibrary(ctx, vid)
		if err != nil {
			return err
		}
		c.country = Access{CountryMode: l.CountryMode, Countries: l.Countries}
		return s.load(ctx, q, &c.p)
	})
	if err == nil && c.p.keyInService {
		c.p.key, _, err = s.Keys.Get(ctx, c.p.assetID.String())
	}
	if err == nil && c.p.key != nil {
		s.cache.putVideo(c)
	}
	return c, err
}

// load reads what serving p needs; a ready video also gets its key, plan and where segments come from.
func (s *module) load(ctx context.Context, q tx, p *playback) error {
	asset, err := q.PlaybackAsset(ctx, p.assetID)
	if err != nil {
		return err
	}
	p.status, p.duration = asset.Status, asset.DurationSeconds.Float64
	if asset.Status != "ready" && asset.Status != "complete" {
		return nil
	}
	switch {
	case asset.EncryptionKey != nil:
		if p.key, err = core.Open(s.SealKey, asset.EncryptionKey); err != nil {
			return err
		}
	case s.Keys != nil:
		p.keyInService = true // read after the transaction: no connection held across the call
	default:
		return errors.New("video's key is in the key service, and KEY_SERVICE is local")
	}
	p.download, p.name = asset.Download.String, asset.Passthrough.String
	p.posterTime, p.posterUploaded = asset.PosterTime, asset.PosterUploadedAt
	if p.segmentBase, err = s.deliveryFor(ctx, q); err != nil {
		return err
	}
	return json.Unmarshal(asset.Plan, &p.plan)
}

// signature is a path signature: exp=<unix>~acl=<path pattern>~kid=<signing key>[~ip=<address>][~wm=<text>]~hmac=<hex>.
// The HMAC-SHA256 is over everything before "~hmac=", exactly as it appears in the address.
type signature struct {
	exp           int64
	acl, kid      string
	ip, watermark string
}

// verifySignature checks sig with the tenant's signing key it names, and that it covers path for this viewer; it
// returns what was signed. Whether it has expired is the caller's call (authorize: strict to start, with grace after).
func (s *module) verifySignature(ctx context.Context, tenantID pgtype.UUID, sig, path string, viewer netip.Addr) (signature, error) {
	t, why, err := s.checkSignature(ctx, tenantID, sig, path, &viewer)
	if err == nil && why != "" {
		err = errTokenInvalid
	}
	return t, err
}

// checkSignature is verifySignature saying why a signature fails, in words for the workspace (never for viewers).
// With viewer nil an ip= in it isn't checked.
func (s *module) checkSignature(ctx context.Context, tenantID pgtype.UUID, sig, path string, viewer *netip.Addr) (t signature, why string, err error) {
	if sig == "" {
		return t, "There is no signature in it.", nil
	}
	signed, mac, ok := strings.Cut(sig, "~hmac=")
	want, hexErr := hex.DecodeString(mac)
	t, parseErr := parseSignature(signed)
	var kid pgtype.UUID
	if len(sig) > 1024 || !ok || hexErr != nil || parseErr != nil || kid.Scan(t.kid) != nil {
		return t, "The signature isn't in the right format: exp, acl and kid, then hmac, joined by ~.", nil
	}
	secret, known := s.cache.secret(tenantID, kid)
	if !known {
		err = inTenant(ctx, s.Pool, tenantID, func(q tx) (err error) {
			if secret, err = q.GetSigningSecret(ctx, kid); err != nil {
				return err
			}
			secret, err = core.Open(s.SealKey, secret)
			return err
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return t, "It names a signing key this workspace doesn't have (" + t.kid + "): deleted, or from another workspace.", nil
		}
		if err != nil {
			return t, "", err
		}
		s.cache.putSecret(tenantID, kid, secret)
	}
	h := hmac.New(sha256.New, secret)
	h.Write([]byte(signed))
	switch {
	case !hmac.Equal(h.Sum(nil), want):
		return t, "The signature doesn't match its key: it was made with another secret, or the address was changed after signing.", nil
	case !t.covers(path):
		return t, "It is signed for " + t.acl + ", which doesn't include this video.", nil
	}
	if t.ip != "" && viewer != nil {
		if a, err := netip.ParseAddr(t.ip); err != nil || a.Unmap() != viewer.Unmap() {
			return t, "It works only from " + t.ip + ", not from " + viewer.String() + ".", nil
		}
	}
	return t, "", nil
}

// parseSignature reads the signed part of a signature (without ~hmac=); every field once, exp and acl required.
func parseSignature(signed string) (signature, error) {
	var t signature
	seen := map[string]bool{}
	for _, f := range strings.Split(signed, "~") {
		k, v, ok := strings.Cut(f, "=")
		if !ok || seen[k] {
			return t, errTokenInvalid
		}
		seen[k] = true
		v, err := url.QueryUnescape(v)
		if err != nil {
			return t, errTokenInvalid
		}
		switch k {
		case "exp":
			if t.exp, err = strconv.ParseInt(v, 10, 64); err != nil {
				return t, errTokenInvalid
			}
		case "acl":
			t.acl = v
		case "kid":
			t.kid = v
		case "ip":
			t.ip = v
		case "wm":
			t.watermark = v
		default:
			return t, errTokenInvalid
		}
	}
	if t.exp == 0 || !strings.HasPrefix(t.acl, "/") {
		return t, errTokenInvalid
	}
	return t, nil
}

// covers says whether the acl allows path: an exact path, or a prefix ending in /* (which also covers the page at
// the prefix itself, /{library}/{video}).
func (t signature) covers(path string) bool {
	prefix, wild := strings.CutSuffix(t.acl, "*")
	if !wild {
		return path == t.acl
	}
	return strings.HasPrefix(path, prefix) || path+"/" == prefix
}

// signPath builds a signature verifySignature accepts.
func signPath(kid string, secret []byte, exp int64, acl, ip, watermark string) string {
	esc := func(v string) string { return strings.ReplaceAll(url.QueryEscape(v), "~", "%7E") }
	signed := "exp=" + strconv.FormatInt(exp, 10) + "~acl=" + esc(acl) + "~kid=" + kid
	if ip != "" {
		signed += "~ip=" + esc(ip)
	}
	if watermark != "" {
		signed += "~wm=" + esc(watermark)
	}
	h := hmac.New(sha256.New, secret)
	h.Write([]byte(signed))
	return signed + "~hmac=" + hex.EncodeToString(h.Sum(nil))
}

// Players fetch playlists and keys cross-origin, so errors carry CORS headers too.
func playbackHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
}

// masterPlaylist serves playlist.m3u8: the qualities and captions as relative links, each carrying the signature.
func (s *module) masterPlaylist(w http.ResponseWriter, r *http.Request, p playback) {
	body, err := s.Store.ReadObject(r.Context(), p.prefix()+"master.m3u8")
	if nsk := (*types.NoSuchKey)(nil); errors.As(err, &nsk) {
		core.WriteError(w, http.StatusNotFound, "not_found") // a video whose files are missing
		return
	}
	if err != nil {
		core.InternalError(w, r, err)
		return
	}
	var captions []db.ListCaptionsRow
	if err := inTenant(r.Context(), s.Pool, p.tenantID, func(q tx) (err error) {
		captions, err = q.ListCaptions(r.Context(), p.assetID)
		return err
	}); err != nil {
		core.InternalError(w, r, err)
		return
	}
	if p.segmentBase != s.OriginURL {
		// Behind a CDN, offer the same qualities again from the origin: players switch to them when the CDN fails.
		body = withBackupVariants(body, func(uri string) string { return uri + queryJoin(uri) + "via=origin" })
	}
	body = withCaptions(body, captions, func(c db.ListCaptionsRow) string { return "captions_" + c.ID.String() + ".m3u8" })
	s.writePlaylist(w, p, rewritePlaylist(body, p.link, p.link))
}

// renditionPlaylist serves {rendition}.m3u8: segments from the origin or CDN, the key beside the playlist.
func (s *module) renditionPlaylist(w http.ResponseWriter, r *http.Request, p playback, name string) {
	body, err := s.Store.ReadObject(r.Context(), p.prefix()+name+".m3u8")
	if nsk := (*types.NoSuchKey)(nil); errors.As(err, &nsk) {
		core.WriteError(w, http.StatusNotFound, "not_found") // e.g. 1080p asked for while only the fast rungs exist
		return
	}
	if err != nil {
		core.InternalError(w, r, err)
		return
	}
	base := p.segmentBase
	if r.URL.Query().Get("via") == "origin" {
		base = s.OriginURL // the backup copy of each quality, for when the CDN is failing
	}
	segment := func(uri string) string { return base + "/" + p.prefix() + uri }
	s.writePlaylist(w, p, rewritePlaylist(body, segment, func(uri string) string {
		if strings.HasPrefix(uri, "/keys/") {
			if p.keyInService {
				return s.Keys.PlayerURL(p.assetID.String(), time.Now().Add(time.Duration(p.duration*float64(time.Second))+gracePastExpiry))
			}
			return p.link("key")
		}
		return segment(uri)
	}))
}

// writePlaylist sends a playlist; a signed video's carry the viewer's signature, so they are never shared.
func (s *module) writePlaylist(w http.ResponseWriter, p playback, body []byte) {
	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	if p.policy == "public" {
		w.Header().Set("Cache-Control", "public, max-age=60")
	} else {
		w.Header().Set("Cache-Control", "private, max-age=60")
	}
	w.Write(body)
}

// withBackupVariants lists every quality a second time right after itself, with the same description and the address
// backup gives. HLS players read a repeat as a redundant stream and move to it by themselves when the first fails.
func withBackupVariants(body []byte, backup func(uri string) string) []byte {
	lines := strings.Split(strings.TrimRight(string(body), "\n"), "\n")
	var out strings.Builder
	for i := 0; i < len(lines); i++ {
		out.WriteString(lines[i] + "\n")
		if strings.HasPrefix(lines[i], "#EXT-X-STREAM-INF") && i+1 < len(lines) && lines[i+1] != "" && !strings.HasPrefix(lines[i+1], "#") {
			out.WriteString(lines[i+1] + "\n" + lines[i] + "\n" + backup(lines[i+1]) + "\n")
			i++
		}
	}
	return []byte(out.String())
}

// queryJoin is the character that adds a parameter to uri: ? when it has none yet, & when it has.
func queryJoin(uri string) string {
	if strings.Contains(uri, "?") {
		return "&"
	}
	return "?"
}

// rewritePlaylist maps every URI in a playlist: bare lines through line, URI="…" attributes through attr.
func rewritePlaylist(body []byte, line, attr func(string) string) []byte {
	var out strings.Builder
	for _, l := range strings.Split(strings.TrimRight(string(body), "\n"), "\n") {
		switch {
		case l == "":
		case strings.HasPrefix(l, "#"):
			l = uriAttr.ReplaceAllStringFunc(l, func(m string) string {
				return `URI="` + attr(strings.TrimSuffix(strings.TrimPrefix(m, `URI="`), `"`)) + `"`
			})
		default:
			l = line(l)
		}
		out.WriteString(l + "\n")
	}
	return []byte(out.String())
}

func validPolicy(p string) bool { return p == "public" || p == "signed" }

func (s *module) createSigningKey(w http.ResponseWriter, r *http.Request, pr core.Principal) {
	secret := make([]byte, 32)
	rand.Read(secret)
	sealed, err := core.Seal(s.SealKey, secret)
	if err != nil {
		core.InternalError(w, r, err)
		return
	}
	var row db.CreateSigningKeyRow
	err = inTenant(r.Context(), s.Pool, pr.TenantID, func(q tx) (err error) {
		row, err = q.CreateSigningKey(r.Context(), sealed)
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusCreated, map[string]any{"id": row.ID, "created_at": row.CreatedAt, "secret": base64.StdEncoding.EncodeToString(secret)})
}

func (s *module) listSigningKeys(w http.ResponseWriter, r *http.Request, pr core.Principal) {
	c, err := core.ParseCursor(r)
	var after pgtype.UUID
	if err == nil {
		after, err = c.AfterUUID()
	}
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	var keys []db.ListSigningKeysRow
	var total int64
	err = inTenant(r.Context(), s.Pool, pr.TenantID, func(q tx) (err error) {
		keys, err = q.ListSigningKeys(r.Context(), db.ListSigningKeysParams{Pattern: c.Like(), AfterAt: c.At, AfterID: after, Lim: c.Fetch()})
		if err != nil {
			return err
		}
		total, err = q.CountSigningKeys(r.Context(), c.Like())
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	core.WriteJSON(w, http.StatusOK, core.PagedTotal(keys, c, func(k db.ListSigningKeysRow) (time.Time, string) {
		return k.CreatedAt.Time, k.ID.String()
	}, total))
}

func (s *module) deleteSigningKey(w http.ResponseWriter, r *http.Request, pr core.Principal) {
	var n int64
	err := withPathID(s.Deps, r, pr, func(q tx, id pgtype.UUID) (err error) {
		n, err = q.DeleteSigningKey(r.Context(), id)
		return err
	})
	switch {
	case err != nil:
		core.RespondError(w, r, err)
	case n == 0:
		core.WriteError(w, http.StatusNotFound, "not_found")
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

var errNoSigningKey = core.APIError{Status: http.StatusConflict, Code: "no_signing_key"}

// createSignedURL signs a video's (or a whole library's) addresses with the tenant's newest signing key, exactly as a
// customer's backend would, and returns the signature with the video's playlist and page addresses.
func (s *module) createSignedURL(w http.ResponseWriter, r *http.Request, pr core.Principal) {
	var in struct {
		VideoID   string `json:"video_id"`
		Scope     string `json:"scope"` // video (default) or library: every video in the video's library
		ExpiresIn *int   `json:"expires_in"`
		IP        string `json:"ip"`        // only this viewer address may use it
		Watermark string `json:"watermark"` // shown over the video by Ulka's player; signed, so viewers can't change it
	}
	if !core.Decode(w, r, &in) {
		return
	}
	if utf8.RuneCountInString(in.Watermark) > 64 || strings.ContainsFunc(in.Watermark, unicode.IsControl) {
		core.WriteError(w, http.StatusBadRequest, "invalid_watermark")
		return
	}
	if in.Scope != "" && in.Scope != "video" && in.Scope != "library" {
		core.WriteError(w, http.StatusBadRequest, "invalid_scope")
		return
	}
	if in.IP != "" {
		if _, err := netip.ParseAddr(in.IP); err != nil {
			core.WriteError(w, http.StatusBadRequest, "invalid_ip")
			return
		}
	}
	expiresIn := 3600
	if in.ExpiresIn != nil {
		if expiresIn = *in.ExpiresIn; expiresIn < 60 || expiresIn > 86400 {
			core.WriteError(w, http.StatusBadRequest, "invalid_expires_in")
			return
		}
	}
	var vid pgtype.UUID
	if vid.Scan(in.VideoID) != nil {
		core.RespondError(w, r, errNotFound)
		return
	}
	var key db.LatestSigningKeyRow
	var asset db.Asset
	err := inTenant(r.Context(), s.Pool, pr.TenantID, func(q tx) (err error) {
		if asset, err = q.GetAsset(r.Context(), vid); err != nil {
			return err
		}
		key, err = q.LatestSigningKey(r.Context())
		if errors.Is(err, pgx.ErrNoRows) {
			return errNoSigningKey
		}
		if err != nil {
			return err
		}
		key.Secret, err = core.Open(s.SealKey, key.Secret)
		return err
	})
	if err != nil {
		core.RespondError(w, r, err)
		return
	}
	video := "/" + asset.LibraryID.String() + "/" + vid.String()
	acl := video + "/*"
	if in.Scope == "library" {
		acl = "/" + asset.LibraryID.String() + "/*"
	}
	expires := time.Now().Add(time.Duration(expiresIn) * time.Second).Truncate(time.Second)
	sig := signPath(key.ID.String(), key.Secret, expires.Unix(), acl, in.IP, in.Watermark)
	core.WriteJSON(w, http.StatusCreated, map[string]any{
		"signature": sig, "expires_at": expires.UTC().Format(time.RFC3339),
		"playback_url": s.PlayerURL + video + "/playlist.m3u8?token=" + url.QueryEscape(sig), "embed_url": s.PlayerURL + video + "?token=" + url.QueryEscape(sig),
	})
}
