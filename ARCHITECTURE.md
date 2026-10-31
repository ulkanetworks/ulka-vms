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
| nginx origin | `compose.yaml` | serves encrypted segments from storage; its access log becomes delivery usage |
| Vector, ClickHouse | `compose.yaml` | ship the origin's log; hold delivery rollups and telemetry |

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
- `core.KeyStore` on `core.Deps`: keep video keys in a key service instead of the database.
- `core.AddProduct`: a product of your own, granted by roles and API key scopes like video.
- Lists you append to at start: `core.Messages`, `core.WebhookEvents`, `core.FieldRules`, `core.ExtraLimitDefaults`,
  `accounts.MetaProducts`, `accounts.Capabilities`, `accounts.ExtraMeta`, `usage.Units`, `usage.Used`,
  `notices.Sources`.

Before 1.0 these may change between minor versions; the changelog says when they do.

## Scaling

One machine runs everything for a small audience. In order, as load grows: more worker machines for encoding; a CDN
in front of the origin (delivery settings); a second API machine behind a load balancer, which then needs the
playback cache shared (`video.PlaybackTTL` bounds how stale it is today); a Postgres read replica and connection
pooling.
