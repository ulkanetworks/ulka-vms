# Contributing to Ulka VMS

Thank you for helping. Bug reports, fixes, documentation and features are all welcome.

## Before you start

- **A bug:** open an issue with what you did, what you expected and what happened. Include the version
  (`git describe --tags`) and any error code the API returned.
- **A feature or a large change:** open an issue first and describe the problem it solves. Agreeing on the approach
  before you write code saves you time.
- **A security problem:** don't open an issue. Follow [SECURITY.md](SECURITY.md).

## Contributor License Agreement

Ulka Networks also offers a hosted service built on this code. To keep that possible, every contributor signs our
Contributor License Agreement (CLA) once, before their first pull request is merged. It gives Ulka Networks a licence to
use your contribution, including in that service; you keep the copyright to your work. A bot asks you to sign when
you open your first pull request.

## Making a change

1. Fork the repository and make a branch from `main`.
2. Set up the project as in the [README](README.md#getting-started).
3. Make the change, with tests: new behaviour gets a test, and a bug fix starts with a test that fails without the fix.
4. Check everything passes:
   ```sh
   go build ./... && go vet ./... && go test ./...
   cd web && npm run check && npm test
   ```
5. If people using Ulka VMS will notice the change, add a line to [CHANGELOG.md](CHANGELOG.md).
6. Open a pull request against `main` that says what changed and why.

## How the code is written

- **The API decides.** Every rule, limit and permission lives in the Go API; the console only checks the same rules
  early, using the API's own words (`/v1/meta`). A new API rule needs its console check in the same change.
- **Errors are stable codes** (`core.APIError`) with plain words in `core.Messages`; never show raw error text.
- **Every public route is in `api/openapi.json`**; `app/spec_test.go` fails when code and spec disagree.
- **Each module owns its tables** and exposes plain functions in its `public.go`; `app/ownership_test.go` enforces it.
  Every workspace table has row-level security.
- **Plain words** in everything a person reads, error messages included.
- Keep it simple: the smallest change that fully solves the problem, no new dependency without discussing it.

[CLAUDE.md](CLAUDE.md) and [`.claude/rules`](.claude/rules) hold the detailed rules for each area.

## Code of conduct

Everyone taking part follows our [Code of Conduct](CODE_OF_CONDUCT.md).
