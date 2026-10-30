# Ulka VMS

Open-source video hosting you run on your own servers: upload a video once, and it plays smoothly, encrypted, on any
phone or screen. For teams that want their videos, viewers and costs on infrastructure they control.

Ulka VMS is the open-source edition of the video platform behind [Ulka](https://ulka.co).

## Features

- **Uploads that survive bad connections:** send a file whole or in parts, and resume where it stopped. Or import one
  from a link.
- **Encoding for every screen:** each video is encoded into several qualities (HLS) in parallel pieces across your
  workers, with the low qualities playable first.
- **Encrypted at rest and in playback:** every video gets its own AES-128 key, sealed in your database.
- **Private videos:** signed playback links that expire, limited by website, country or viewer address, with an
  optional watermark of the viewer's name.
- **A player to embed:** adaptive quality, chapters, captions, storyboard previews and keyboard shortcuts, styled per
  library.
- **Libraries and folders**, covers, captions, chapters, MP4 downloads and per-library encoding presets.
- **Delivery straight from your server or through any CDN:** Ulka CDN, Cloudflare, CloudFront, Bunny, Fastly or
  Akamai, with setup steps for each.
- **Teams:** workspaces, members with roles, API keys with scopes and IP allow lists, and signed webhooks.
- **Usage:** minutes encoded and stored, and video delivered, per workspace and day.
- **Viewer checks:** a viewer can run a playback check in their own browser and send you the result with a code.
- **The API is the product:** everything the console does is in the [OpenAPI spec](api/openapi.json).

## Getting started

### Requirements

- Go 1.27 and Node 24
- Docker, for Postgres, S3-compatible storage (SeaweedFS), ClickHouse and the nginx origin
- On the path: `ffmpeg` and `ffprobe`, Shaka [`packager`](https://github.com/shaka-project/shaka-packager/releases)
  v3.9 and `cwebp` (package `webp`)

### Install and configure

```sh
git clone https://github.com/ulkanetworks/ulka-vms.git && cd ulka-vms
cp .env.example .env
```

Fill in the blanks in `.env`: `POSTGRES_PASSWORD`, `ULKA_APP_PASSWORD`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and
`CLICKHOUSE_PASSWORD` (any long random values, `openssl rand -base64 24`), and `SEAL_KEY` (`openssl rand -base64 32`).
`SEAL_KEY` encrypts video keys and other secrets: back it up and never change it once there is data.

### Run

```sh
set -a; . ./.env; set +a
docker compose up -d                     # Postgres, SeaweedFS, origin, ClickHouse, telemetry
docker compose exec postgres psql -U postgres -c "CREATE DATABASE ulka_vms_test"   # for the tests
go run ./cmd/ulka-vms migrate
go run ./cmd/ulka-vms api                # the API on API_ADDR
go run ./cmd/ulka-vms worker             # encoding and background jobs (another terminal)
cd web && npm ci && npm run dev          # the console on http://localhost:5173
```

Open the console, create your account and upload a video.

## Usage

The console covers everything; programs use the API with a key from **API keys**:

```sh
curl http://localhost:5173/v1/assets -H "Authorization: Bearer $KEY"
```

The guides and the API reference are in the console under **Docs**.

Each workspace has limits (largest upload, encoding minutes a month). To change them for a workspace:

```sh
go run ./cmd/ulka-vms limits <workspace id> encode_minutes_monthly=6000 max_upload_bytes=21474836480
```

## Development

```sh
go build ./... && go vet ./...
go test ./...                    # needs the compose services; uses the ulka_vms_test database
cd web && npm run check          # type check
cd web && npm test               # console unit tests
```

The layout: `core` is the shared kernel (sign-in, permissions, errors, tenancy), `accounts`, `video`, `transcoder`,
`player`, `webhooks`, `usage` and `notices` are the modules, `app` assembles them, `cmd/ulka-vms` is the binary,
`migrations` the Postgres schema and `web` the React console. [ARCHITECTURE.md](ARCHITECTURE.md) explains how they
fit together and how to build on Ulka VMS.

## Deployment

One server can run everything; workers can be added on more machines for encoding.

1. Build: `go build -o ulka-vms ./cmd/ulka-vms` and `cd web && npm ci && npm run build` (files in `web/dist`).
2. Settings: `.env` as above, with real https addresses for `PUBLIC_URL`, `PLAYER_URL`, `ORIGIN_URL` and `DOCS_URL`,
   and a real mail provider (`MAIL_PROVIDER=smtp` or `resend`). Start-up refuses development values on a public
   address.
3. Run `docker compose up -d`, `ulka-vms migrate`, then `ulka-vms api` and `ulka-vms worker` as services.
4. Put [Caddy](https://caddyserver.com) in front with [`deploy/Caddyfile`](deploy/Caddyfile): it serves the console,
   the player and the origin over HTTPS.

Storage can be any S3-compatible store; set `S3_*` and leave `COMPOSE_PROFILES` empty to skip SeaweedFS.

## Contributing

Contributions are welcome: read [CONTRIBUTING.md](CONTRIBUTING.md) first. Report security problems privately as
described in [SECURITY.md](SECURITY.md), never in a public issue.

## License

Ulka VMS is licensed under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a
service, you must offer its source to its users.

"Ulka" and the Ulka logo are trademarks of Ulka Networks. The licence covers the code, not the name: a fork must use
its own name and logo.
