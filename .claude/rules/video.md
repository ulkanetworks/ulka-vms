---
paths:
  - "video/**"
  - "player/**"
  - "web/src/components/library/**"
  - "web/src/components/player/{Watch,Check}.tsx"
  - "web/src/components/{UploadDock,DeliverySettings,Pipeline,Technical,FindReport}.tsx"
  - "web/src/routes/_app/videos/**"
  - "web/src/routes/$lib/**"
  - "web/src/routes/check/**"
  - "web/src/lib/{address,check,preview,watch,uploads,library-tabs}.ts"
  - "e2e/{playback*,signed_urls,video_*,playcheck,viewer_check,poster,libraries,library_stats,resumable,player_templates,delivery,timelines,technical}_test.go"
---
# Videos (`video`, `player`)

## The catalog
- A library groups videos and holds their settings, player settings included (the libraries table's `player`
  column, whose meaning belongs to `player`). Delivery, signing keys and webhooks stay workspace-wide on purpose. `EnsureDefaultLibrary`
  makes "Main" wherever a library is needed.
- Folders nest; composite foreign keys keep a video's library, folder and a folder's parent inside one workspace.
- Trash is `deleted_at` on `assets`: out of lists, not playable, purged by the daily cleanup; deleting a folder trashes
  the videos below. Deleting through the API still deletes at once.
- Privacy is `playback_policy` (public or signed); changing it never changes the video's address.
- Details and chapters live on `assets`, checked in `details.go` and mirrored in the console.
- The cover is a frame or an upload, one at most; uploads are redrawn by `video.Options`' `ConvertImage`, by default
  `ffmpegConvert`, which names ffmpeg's reader from the file's first bytes (`imageDemuxer`), never letting it guess. Poster addresses carry a
  version (`posterVersion`) so a change shows at once despite caching.
- The processing timeline is written in the same statement as each state change, never read from River (it forgets
  finished jobs); `timelineView` turns it into the view.
- Technical details (source, encoding, the work done, storage) are behind the video page's Technical tab, read from
  `GET /v1/assets/{id}/technical`: whoever runs the server is the one who needs them.

## Watching
- The player host's home shows `PLAYER_DEMO` (a public video, or none) when `onPlayerHost()`; the console's other
  pages never run there.
- Videos are watched on the player host (`PLAYER_URL`) at `/{library}/{video}`, plus `?token=` when signed. Ids never
  change; there are no playback ids. Files beside it come from `GET /play/{path...}`; everything else is the SPA's
  watch page, which reads `config.json` with the referrer.
- Signatures are Akamai-style (`signPath`/`parseSignature`, `TestSignatureFormat`), minted by `POST /v1/signed-urls`.
  A token is accepted as written or URL-encoded once. The watch page reads the token from `lib/address.ts` (taken
  before the router re-encodes the address bar), never from `location`.
- Expiry is strict only to start (`playlist.m3u8`, `config.json`, `download.mp4`); everything else a session fetches
  is accepted up to the video's length plus `gracePastExpiry` past it. HMAC, acl and ip are checked on every request
  (`authorize`; `checkSignature` is the one signature path).
- Relative links don't carry the query, so every link a signed video's playlist, captions, storyboard or
  `config.json` gives carries the viewer's token (`link` in `playback.go`).
- Who may watch is `video.Access`: allowed or blocked websites on the player config (a hotlink guard; signatures are
  the security), and country rules on the config and on every playlist and key (`Geo` on `core.Deps`). An address
  the database can't place is allowed in allow mode and refused in deny mode, except loopback and private addresses. Without a
  country database the API still starts, with country rules off and a warning in its log.
- A viewer's address is `core.ClientIP`, which believes forwarded headers only from `TRUSTED_PROXIES`: set wrong
  behind Cloudflare, every viewer looks like the proxy and country rules misfire. Tests name viewers with
  X-Forwarded-For and load the country database when `GEOIP_DB` is set.
- Playback reads a ready video's facts from memory (`PlaybackTTL`; tests shorten it). Every `video:write` route is
  wrapped in `s.forgetting` (`TestPlaybackCacheForgets`); a new route that changes what playback reads must be
  `video:write` or call `forgetTenant`. Changes from elsewhere show within the TTL; a second API machine would need a
  shared cache.
- Player templates (`player.Templates`) are named behaviours a library or a single embed (`?template=`) applies; a
  new one also needs the spec's enum and `invalid_template`'s words.

## Keys, storage, uploads
- Each video's AES-128 key is made at plan time and sealed in `assets` (`core.Seal`); the player host serves it. With
  `KEY_SERVICE` set to securedrm (`app/keys.go`, the client in `securedrm/`), or an application's own `core.KeyStore` on
  `Deps.Keys`, keys live in a key service instead: then only the IV is stored, and playlists send players to the
  service. Never assign a nil pointer to `Deps.Keys`: an
  interface holding one isn't nil.
- Storage keys are `<tenant>/<asset>/…`; deleting a video deletes the prefix, so per-video files go under it.
  Captions are WebVTT under it, added to the master playlist when served (`withCaptions`), never baked in.
- Uploads are our own protocol on `upload_url` (`upload.go`; the id is the permission; refused once whole): one
  `PUT` of the whole file, or parts in order with `Content-Range`, `GET` saying how much arrived; the last byte calls
  `completeUpload` (`TestResumableUpload`). Parts take an `upload_locks` lease; storage is one S3 multipart upload.
- MP4 downloads are built from the published HLS, stream through the API and count with segments in Usage; move them
  to the origin once they are a real share of traffic.

## Delivery
- Behind a CDN the master playlist lists each quality twice (`withBackupVariants`); the second copy fetches segments
  from the origin, so players fall back on their own.
- The origin sends its own CORS headers and hides storage's: two `Access-Control-Allow-Origin` values fail in browsers
  while curl and ffmpeg work. Test playback in a browser. Segments cache for a year, so a bad response stays cached.
- Delivery modes are `origin` and `custom` (with `providers` for setup steps, Ulka CDN among them). An application
  that runs its own CDN passes a `ManagedCDN` in `video.Options`: then the modes are `origin` and `ulka_cdn`, and
  segments come from its distribution once `Active`, the origin until then (`TestManagedDelivery`).

## Checks
A new playback rule or file a player fetches needs a step in each:
- the viewer check (`/check/{library}/{video}`, `Check.tsx`), which runs a player's steps in the viewer's browser and
  files a `UL-` report (`playback_reports`), worded for viewers, the server's words kept in `cause`;
- the Troubleshoot tab's `PlaybackCheck` (`playcheck.go`), real requests through the player host as a cross-site
  browser makes them (tests swap `CheckClient`), and `LinkCheck` (`linkcheck.go`), which explains one viewer's address.
