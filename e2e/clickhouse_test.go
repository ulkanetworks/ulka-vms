package e2e

import (
	"context"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/ulkanetworks/ulka-vms/core"
)

var sqlComment = regexp.MustCompile(`--[^\n]*`)

// provisionClickHouse creates the test database named in rawURL (?database=) and runs deploy/clickhouse in it,
// the same files a fresh ClickHouse container runs, so tests never share tables with development.
func provisionClickHouse(ctx context.Context, rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return err
	}
	server := *u
	q := server.Query()
	db := q.Get("database")
	q.Del("database")
	server.RawQuery = q.Encode()
	noRows := func([]byte) error { return nil }
	if err := core.ClickHouseQuery(ctx, server.String(), "CREATE DATABASE IF NOT EXISTS "+db, nil, noRows); err != nil {
		return err
	}
	files, err := filepath.Glob("../deploy/clickhouse/*.sql")
	if err != nil {
		return err
	}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			return err
		}
		for _, stmt := range strings.Split(sqlComment.ReplaceAllString(string(b), ""), ";") {
			if stmt = strings.TrimSpace(stmt); stmt != "" {
				if err := core.ClickHouseQuery(ctx, rawURL, stmt, nil, noRows); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
