package core

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"net/http"

	"github.com/jackc/pgx/v5"
)

// Limits is what one workspace may use. New workspaces get DefaultLimits; admins change them per workspace.
type Limits struct {
	MaxUploadBytes       int64 `json:"max_upload_bytes"`
	EncodeMinutesMonthly int   `json:"encode_minutes_monthly"`
}

var DefaultLimits = Limits{MaxUploadBytes: 5 << 30, EncodeMinutesMonthly: 600}

// ExtraLimitDefaults are the defaults of limits an application built on ulka-vms adds, by their JSON names.
var ExtraLimitDefaults = map[string]any{}

var (
	ErrUploadTooLarge     = APIError{Status: http.StatusRequestEntityTooLarge, Code: "upload_too_large"}
	ErrEncodeLimitReached = "encode_limit_reached" // a video's error code: the month's encoding minutes are used up
)

// LimitsFor reads q's tenant's limits, each unset one at its default.
func LimitsFor(ctx context.Context, q TenantTx) (Limits, error) {
	l := DefaultLimits
	return l, ReadLimits(ctx, q, &l)
}

// ReadLimits fills dst, already holding the defaults, with q's tenant's stored overrides. An application built on
// ulka-vms keeps its own limits in the same overrides under its own names.
func ReadLimits(ctx context.Context, q TenantTx, dst any) error {
	raw, err := q.GetLimits(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, dst)
}

// ReadAllLimits fills dst with every limit by its JSON name: ulka-vms's and the application's, each unset one at its
// default. /v1/limits shows them.
func ReadAllLimits(ctx context.Context, q TenantTx, dst *map[string]any) error {
	b, err := json.Marshal(DefaultLimits)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(b, dst); err != nil {
		return err
	}
	maps.Copy(*dst, ExtraLimitDefaults)
	return ReadLimits(ctx, q, dst)
}
