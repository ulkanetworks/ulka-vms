package migrations

import "embed"

// FS holds the schema migrations, applied in name order by core.Migrate.
//
//go:embed *.sql
var FS embed.FS
