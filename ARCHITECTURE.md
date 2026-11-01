# Architecture

Ulka VMS is a modular monolith: one Go binary, `ulka-vms`, run as an API process and any number of worker processes
over one Postgres database, S3-compatible storage and ClickHouse. A React console talks to the same public API every
program uses.

## Processes

| Process | Command | Does |
|---|---|---|
| API | `ulka-vms api` | the public API, the console's API, and the player host's files (under `/play/`) |
| Worker | `ulka-vms worker` | River jobs (probe, package, storyboard, downloads, webhooks, metering, clean-up) and encoding |
| Migrations | `ulka-vms migrate` | River's schema, then each set of `migrations` in order |
| Origin | `ulka-vms origin` | serves encrypted segments from the private bucket with the server's storage key; each response is a delivery row in ClickHouse |
| ClickHouse | `compose.yaml` | delivery rows and rollups, and telemetry |
| S3-compatible storage | outside (`S3_*`) | sources, segments, covers, downloads; private, read only with the key |

Workers are stateless and can run on many machines. `WORKER_QUEUES` chooses which job queues a machine works and
`WORKER_ENCODE_SLOTS` how many video pieces it encodes at once, so an encoding machine and a webhook machine can
differ.

## Modules

| Module | Owns |
|---|---|
| `core` | the shared kernel: sign-in and sessions, permissions, errors and their words, tenancy (row-level security), limits, storage, mail, telemetry |
| `accounts` | sign-up, sign-in, members, invites, API keys, settings, `/v1/meta`, daily clean-up of the kernel's rows |
| `video` | libraries, folders, videos, uploads, playback and signing, captions, covers, downloads, delivery, checks |
| `transcoder` | encoding: probing, plans, the scheduler that hands video pieces to workers, packaging, storyboards |
| `player` | player settings and templates |
| `webhooks` | endpoints, signed deliveries and retries |
| `usage`, `notices` | monthly usage and limits; what needs a workspace's attention |
| `securedrm` | the client of SecureDRM, the optional hosted key service (`KEY_SERVICE` securedrm); no tables |
| `app` | assembly: routes, workers, queues, the command line, and the extension points |

A module owns its tables and its generated queries; others call its `public.go`. `transcoder` imports only `core`.
`app/ownership_test.go` enforces both.

## A video's path

1. `POST /v1/uploads` and `POST /v1/assets` create the video; the file arrives in parts on its `upload_url` and is
   stored as one S3 multipart upload.
2. A probe job reads it and makes a plan (renditions from the library's preset), and the video's AES-128 key.
3. The plan becomes encode tasks. Workers claim pieces through the scheduler, workspaces taking turns, the fast lane
   (low qualities) first.
4. Packaging writes encrypted HLS (fMP4) under `<workspace>/<video>/`. The video is `ready` once it plays, `complete`
   once every quality is done; each step emits a webhook event.
5. A viewer opens `<PLAYER_URL>/<library>/<video>`: the API serves the playlists and key (checking the signature and
   access rules), and segments come from the origin or the workspace's CDN.

## Video keys

Every video is encrypted (HLS AES-128) with its own key, made at plan time. `KEY_SERVICE` says where keys live:

| `KEY_SERVICE` | Where the key is | Who hands it to players |
|---|---|---|
| local | sealed in `assets` with `SEAL_KEY` (`core.Seal`) | the player host, after checking the signature and access rules |
| securedrm | SecureDRM, Ulka Networks' hosted key service; the database keeps only the IV | SecureDRM, to a player carrying a short-lived token this server signed |

Both are a `core.KeyStore` behind `Deps.Keys` (nil means local); `app/keys.go` picks one at start. With securedrm, a
refused API key stops start-up and an unreachable service only warns. The `securedrm` package is the client of
SecureDRM's public API only: how SecureDRM stores and protects keys stays inside that service. An application built
on Ulka VMS can plug in its own `core.KeyStore` instead. Switching applies to new videos: ones encrypted with
database keys play only while `KEY_SERVICE` is local.

## Building on Ulka VMS

The hosted Ulka is an application built on these packages. Anyone can build one the same way:

```go
func main() {
	app.Main(app.Extension{
		Name:       "myapp",
		Migrations: mymigrations.FS,              // applied after Ulka VMS's, as myapp/<file>
		Configure:  func(cfg *app.Config) { ... }, // read your own settings
		Routes:     myRoutes,                      // add your API
		Video:      func(d *core.Deps) video.Options { return video.Options{Managed: myCDN} },
		Workers:    myWorkers,
		Jobs:       myPeriodicJobs,
	})
}
```

The extension points:

- `app.Extension`: settings and their checks, routes, workers, periodic jobs, queues, migrations, commands, the API
  description served (`OpenAPI`), and how a worker machine runs (`ServeNode`).
- `video.Options`: a CDN the application runs (`ManagedCDN`), and how uploaded covers are redrawn (`ImageConvert`).
- `core.KeyStore` on `core.Deps`: keep video keys in a key service instead of the database. Ulka VMS ships one,
  SecureDRM (`securedrm/`, chosen with `KEY_SERVICE` securedrm).
- `core.AddProduct`: a product of your own, granted by roles and API key scopes like video.
- Lists you append to at start: `core.Messages`, `core.WebhookEvents`, `core.FieldRules`, `core.ExtraLimitDefaults`,
  `accounts.MetaProducts`, `accounts.Capabilities`, `accounts.ExtraMeta`, `usage.Units`, `usage.Used`,
  `notices.Sources`.

Before 1.0 these may change between minor versions; the changelog says when they do.

## Installs and releases

A pushed `v*` tag runs `.github/workflows/release.yml`: it builds the console once and, with `scripts/package.sh`,
one archive per processor (`ulka-vms-linux-amd64.tar.gz`, `…-arm64.tar.gz`) holding the program, the built console,
`compose.yaml` and the service and proxy files. They are published with `install.sh` as the tag's GitHub Release.

`install.sh` is the one-line install (`curl -fsSL …/releases/latest/download/install.sh | sudo bash`). On a first run
it asks for the domain, email and storage settings (or reads them from the environment), checks the three names point
at the server, installs what Ulka VMS runs on, checks the bucket with `ulka-vms check-storage` before writing
anything, writes /etc/ulka-vms/ulka-vms.env with generated secrets, starts the data services, migrates, and starts the
API, worker, origin and HTTPS proxy as services. On a later run it finds the settings and upgrades in place: new
program and console, settings the release added (with their `.env.example` defaults), migrations, containers an
earlier release ran removed, restart. Its messages speak of what it does, not the tools underneath; their output goes
to a log it names. `SELF-HOSTING.md` has the same steps by hand.

A run is safe to repeat. The settings file is written last and in one step, and /etc/ulka-vms/installed only once
everything started: settings without it mean an install that stopped part way, which the next run finishes. Storage
is checked with the new release before anything changes. A database whose settings are gone is never reused (its
passwords went with them); `START_OVER=erase` deletes this server's settings and data, never the bucket.

Servers keep no videos: storage is always an outside S3-compatible bucket, private, read only with the server's key.
`compose.dev.yaml` adds a local stand-in for development and tests and is never shipped.

| Path on a server | What |
|---|---|
| /opt/ulka-vms | the release: `bin/ulka-vms`, `web/`, `compose.yaml`, `deploy/` |
| /etc/ulka-vms/ulka-vms.env | settings and secrets, `SEAL_KEY` among them |
| /etc/ulka-vms/web.env | the three host names and where the proxy sends them |
| Docker volumes | Postgres, ClickHouse |

## Scaling

One machine runs everything for a small audience. In order, as load grows: more worker machines for encoding; a CDN
in front of the origin (delivery settings); a second API machine behind a load balancer, which then needs the
playback cache shared (`video.PlaybackTTL` bounds how stale it is today); a Postgres read replica and connection
pooling.
