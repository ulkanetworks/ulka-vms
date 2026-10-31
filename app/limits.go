package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/ulkanetworks/ulka-vms/core"
)

// limitNames is every limit a workspace has, by its JSON name: ulka-vms's and the application's.
func limitNames(extra map[string]any) ([]string, error) {
	var defaults map[string]any
	b, err := json.Marshal(core.DefaultLimits)
	if err == nil {
		err = json.Unmarshal(b, &defaults)
	}
	maps.Copy(defaults, extra)
	return slices.Sorted(maps.Keys(defaults)), err
}

// SetLimits changes one workspace's limits, given as name=value; the others keep what they were. With no changes
// it only prints them, and with no workspace it lists them all. It connects as the database owner, since no
// workspace may raise its own.
func SetLimits(ctx context.Context, ownerDSN string, extra map[string]any, args []string) error {
	if len(args) == 0 {
		return listWorkspaces(ctx, ownerDSN)
	}
	names, err := limitNames(extra)
	if err != nil {
		return err
	}
	changes := map[string]int64{}
	for _, a := range args[1:] {
		name, raw, ok := strings.Cut(a, "=")
		n, err := strconv.ParseInt(raw, 10, 64)
		if !ok || err != nil || n < 0 || !slices.Contains(names, name) {
			return fmt.Errorf("%q is not name=value with a whole number of 0 or more, and name one of %s", a, strings.Join(names, ", "))
		}
		changes[name] = n
	}
	conn, err := pgx.Connect(ctx, ownerDSN)
	if err != nil {
		return err
	}
	defer conn.Close(context.WithoutCancel(ctx))
	var stored []byte
	err = conn.QueryRow(ctx, "UPDATE tenants SET limits = limits || $2, updated_at = now() WHERE id = $1 RETURNING limits", args[0], changes).Scan(&stored)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("no workspace has the id %s", args[0])
	}
	if err != nil {
		return err
	}
	fmt.Printf("workspace %s: %s (unset limits keep their defaults)\n", args[0], stored)
	return nil
}

// listWorkspaces prints every workspace's id, name and stored limits, for choosing one to change.
func listWorkspaces(ctx context.Context, ownerDSN string) error {
	conn, err := pgx.Connect(ctx, ownerDSN)
	if err != nil {
		return err
	}
	defer conn.Close(context.WithoutCancel(ctx))
	rows, err := conn.Query(ctx, "SELECT id::text, name, limits::text FROM tenants ORDER BY created_at")
	if err != nil {
		return err
	}
	defer rows.Close()
	fmt.Println("usage: limits <workspace id> [name=value ...]")
	for rows.Next() {
		var id, name, limits string
		if err := rows.Scan(&id, &name, &limits); err != nil {
			return err
		}
		fmt.Printf("%s  %s  %s\n", id, name, limits)
	}
	return rows.Err()
}
