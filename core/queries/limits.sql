-- name: GetLimits :one
SELECT limits FROM tenants WHERE id = current_tenant();

-- name: EncodedMinutesThisMonth :one
SELECT coalesce(sum(quantity), 0)::float8 FROM usage_records WHERE meter = 'video_minutes_encoded'
    AND period >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
