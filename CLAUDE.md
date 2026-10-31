# Ulka VMS

Open-source video platform: one Go binary (`ulka-vms`: API, worker, migrations, limits), Postgres, S3-compatible
storage, ClickHouse, and a React console in `web/` (Vite, TanStack Router and Query, coss ui on Base UI). The
hosted Ulka imports these packages and adds its own through `app.Extension`, so every package here is a public API:
see `ARCHITECTURE.md`.

## Where things are
Each area's rules are a file in `.claude/rules/`, loaded when you read or edit a file it covers. Before changing code,
read the rules file of each area the task touches.

| Area | Go | Console (`web/src`) | Rules |
|---|---|---|---|
| Videos: libraries, uploads, playback, signing, delivery, checks | `video`, `player` | `components/library`, `routes/_app/videos`, `routes/$lib` | `video.md` |
| The player (Shaka skin, embed) | | `components/player` | `player.md` |
| Encoding | `transcoder` | | `transcoder.md` |
| Accounts: sign-in, members, invites, settings, API keys, limits | `accounts`, `app/limits.go` | `routes/_auth`, `routes/_app/members.tsx`, `routes/_app/settings.tsx` | this file |
| Kernel: auth, permissions, errors, limits, meta | `core` | | this file |
| Webhooks, usage, notices | `webhooks`, `usage`, `notices` | `routes/_app/webhooks`, `routes/_app/usage.tsx` | this file |
| Assembly, the command line, extension points | `app`, `cmd/ulka-vms` | | this file |
| API spec and its tests | `api/openapi.json`, `app`, `e2e` | | this file and the area's |
| Postgres, ClickHouse | `migrations`, `*/queries`, `deploy/clickhouse` | | `data.md` |
| Any console page | | `web/src` | `console.md` |
| The docs themselves | `CHANGELOG.md`, `README.md`, `ARCHITECTURE.md`, these files | | `docs.md` |

## Commands
```sh
set -a; . ./.env; set +a                 # every Go command needs the environment
go build ./... && go vet ./...           # never a bare `go build ./cmd/ulka-vms`: it drops a binary at the root
go test ./...                            # e2e needs the compose services: docker compose up -d
go test ./e2e/ -run TestName
sqlc generate                            # after changing migrations/ or */queries/
go run ./cmd/ulka-vms migrate            # apply migrations to the dev database
cd web && npm run check                  # route tree + tsc; must report 0 errors
cd web && npm test                       # console unit tests (vitest)
```
- Never run two `go test` runs at once: they share one test database, and one run's workers take the other's jobs.
- The test database keeps earlier runs' data: fixtures that must be unique include a random slug. Tests use their
  own bucket (`S3_BUCKET` plus `-test`), emptied when a run starts.
- Encoding needs `ffmpeg`, `ffprobe`, Shaka `packager` and `cwebp` on the path.

## The API is the product
- The API decides; the console carries no business rules and only checks the same rules early, with the API's words.
  A new API rule needs its console check in the same change. Limits are constants in `core/rules.go`, published by
  `/v1/meta` through `core.FieldRules`; permissions come from `/v1/me`.
- Routes: `mux.HandleFunc("METHOD /path", m.Auth(perm, handler))`, `perm` a product permission (`"video:write"`),
  `core.Anyone` or `core.Session`. `core.Session` is only for the person and the workspace (sign-in, sessions,
  members, invites, API keys): a stolen API key must not reach those. Roles grant through `roleGrants` only; never
  check a role name.
- Every public route is in `api/openapi.json` with `x-ulka-permission` and `x-ulka-errors`. `spec_test.go` fails when
  code and spec disagree, and a full `go test ./e2e/` fails naming any Videos route no test reached (`TestMain`).
- Errors are stable codes (`core.APIError`) whose words live only in `core.Messages`; a new code needs words and a
  place in the spec (`TestEveryCodeHasWords`, `TestSpecListsErrorCodes`). A failure a screen shows is a registered
  plain sentence (`core.PlainFailure`); the raw error is only logged.
- Lists that grow are paged by cursor, newest first: `core.ParseCursor` and `core.PagedTotal`.
- Events: `core.Emit`; every type is in `core.WebhookEvents` and the spec's `webhooks` (`TestWebhookEventsMatchSpec`).
- Text limits count characters (`utf8.RuneCountInString`, as Postgres `length()` does); passwords count bytes.

## Modules and extension points
`core` (shared kernel), `accounts`, `video`, `transcoder`, `player`, `webhooks`, `usage`, `notices`, assembled by
`app`. A module owns its tables and its generated `db` package, which only it imports (anyone may use `core`'s);
others call its `public.go` functions. `ownership_test.go` enforces this; a new table goes under exactly one module
in its `owners` map. `transcoder` imports only `core` (`TestStandaloneModulesImportOnlyCore`).
- Handlers use their module's `inTenant`/`inScope` (over `core.InTenant`/`core.InScope`; row-level security on every
  tenant table), never the bare pool.
- What an application adds goes through the extension points, never a fork of a module: `app.Extension` (settings,
  routes, workers, queues, migrations, commands), `video.Options` (`ManagedCDN`, `ImageConvert`), `core.KeyStore`,
  `core.AddProduct`, and the exported lists `core.Messages`, `core.WebhookEvents`, `core.FieldRules`,
  `core.ExtraLimitDefaults`, `accounts.MetaProducts`, `accounts.Capabilities`, `accounts.ExtraMeta`, `usage.Units`,
  `usage.Used` and `notices.Sources`. Changing one is a breaking change for those applications: say so in the
  changelog.

## Everywhere
- **Keep it simple.** The shortest solution that works: no interface with one implementation, no config for a value
  that never changes, no new dependency without asking. Fix a class of problem in the one place every caller goes
  through.
- Comments: one line, two at most. A deliberate shortcut gets a `ponytail:` comment naming its ceiling.
- Config comes from the environment, checked at boot (`app.MustEnv`, `app.MustURL`, `app.MustSecret`), with no
  baked-in defaults; a setting that can look fine while being wrong also gets a case in `app.CheckEnv`.
- No silent failures: every error is returned, or logged when nobody can receive it.
- Anything sent to a customer-given address connects through `core.PublicClient`; never hold a database
  transaction across such a call. Anything that opens a customer's file goes through the transcoder's `sandboxed`
  ffmpeg, never through exec directly.
- Secrets are sealed (`core.Seal`) and stay out of span names, attributes and logs, as does customer content.
- Telemetry is OpenTelemetry (`core/observe.go`): request spans are named by route pattern. Inside a request or job,
  log with `slog.InfoContext(ctx, …)` so the line joins its trace.
- Tool trap: macOS `sed -E` has no `\b`: use `perl -pi -e` for word-boundary renames, then check the diff.

## Words people see
- The product is **Ulka VMS**. A customer's account is a **workspace** on every screen ("tenant" is only the code's
  name); the people in one are its **members**. Roles: viewer, member, admin, owner.
- A web page that embeds the player or refers viewers is a **website**. Plain language in every user-facing string,
  error states included: no jargon, no internal names, names over IDs.

## Keeping docs true
- A rule, trap or decision the next person needs goes in the same change into the rules file of the area it governs.
  Delete what stops being true. How to write them: `docs.md`.
- A user-visible change adds its line to `CHANGELOG.md` and updates its guide (`web/src/lib/guides`) in the same
  change. A change that makes a doc stale updates it too.
- Branch from `main` and open pull requests into `main`. Commit subjects are prose.
