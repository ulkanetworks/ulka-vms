package core

import (
	"context"
	"fmt"
	"io/fs"
	"log/slog"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivermigrate"
)

// RiverSchema holds River's tables, apart from the application's own.
const RiverSchema = "river"

// Migrations is one set of schema files, applied in name order. Each file's version is Prefix plus its name, so an
// application built on ulka-vms keeps its own files apart from ulka-vms's.
type Migrations struct {
	Prefix string
	FS     fs.FS
}

// Migrate brings River's tables up to date, then applies every unapplied file of each set in turn, all in one transaction.
func Migrate(ctx context.Context, dsn string, sets ...Migrations) error {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return err
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, "CREATE SCHEMA IF NOT EXISTS "+RiverSchema); err != nil {
		return err
	}
	migrator, err := rivermigrate.New(riverpgxv5.New(pool), &rivermigrate.Config{Schema: RiverSchema})
	if err != nil {
		return err
	}
	if _, err := migrator.Migrate(ctx, rivermigrate.DirectionUp, nil); err != nil {
		return err
	}

	return pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		// A blocked ALTER fails in 10 s instead of queueing every write behind it.
		if _, err := tx.Exec(ctx, `SET LOCAL lock_timeout = '10s'; SELECT pg_advisory_xact_lock(hashtext('ulka_migrate'));
			CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
			return err
		}
		for _, set := range sets {
			names, err := migrationFiles(set)
			if err != nil {
				return err
			}
			for _, name := range names {
				version := set.Prefix + name
				var applied bool
				if err := tx.QueryRow(ctx, "SELECT exists(SELECT 1 FROM schema_migrations WHERE version = $1)", version).Scan(&applied); err != nil {
					return err
				}
				if applied {
					continue
				}
				sql, err := fs.ReadFile(set.FS, name)
				if err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, string(sql)); err != nil {
					return fmt.Errorf("%s: %w", version, err)
				}
				if _, err := tx.Exec(ctx, "INSERT INTO schema_migrations (version) VALUES ($1)", version); err != nil {
					return err
				}
				slog.Info("applied migration", "version", version)
			}
		}
		// The app role checks at start that nothing is pending (CheckMigrated), so it may read the list.
		if _, err := tx.Exec(ctx, "GRANT SELECT ON schema_migrations TO ulka_app"); err != nil {
			return err
		}
		// River's tables are shared queue state, not tenant data, so the app role gets them whole.
		_, err = tx.Exec(ctx, `GRANT USAGE ON SCHEMA river TO ulka_app;
			GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA river TO ulka_app;
			GRANT USAGE ON ALL SEQUENCES IN SCHEMA river TO ulka_app;`)
		return err
	})
}

// CheckMigrated refuses to run against a database that is missing migrations this binary knows about,
// which would otherwise fail later, one query at a time.
func CheckMigrated(ctx context.Context, pool *pgxpool.Pool, sets ...Migrations) error {
	var pending []string
	for _, set := range sets {
		names, err := migrationFiles(set)
		if err != nil {
			return err
		}
		for _, name := range names {
			var applied bool
			if err := pool.QueryRow(ctx, "SELECT exists(SELECT 1 FROM schema_migrations WHERE version = $1)", set.Prefix+name).Scan(&applied); err != nil {
				return fmt.Errorf("reading schema_migrations (run migrate): %w", err)
			}
			if !applied {
				pending = append(pending, set.Prefix+name)
			}
		}
	}
	if len(pending) > 0 {
		return fmt.Errorf("database is missing migrations %v: run migrate", pending)
	}
	return nil
}

// migrationFiles is a set's .sql files in name order.
func migrationFiles(set Migrations) ([]string, error) {
	files, err := fs.ReadDir(set.FS, ".")
	if err != nil {
		return nil, err
	}
	var names []string
	for _, f := range files {
		if strings.HasSuffix(f.Name(), ".sql") {
			names = append(names, f.Name())
		}
	}
	slices.Sort(names)
	return names, nil
}
