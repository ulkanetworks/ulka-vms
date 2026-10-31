-- name: RecordUsage :exec
INSERT INTO usage_records (meter, key, period, region, quantity) VALUES (@meter, @key, date_trunc('hour', @at::timestamptz), @region, @quantity)
ON CONFLICT (meter, key) DO UPDATE SET quantity = excluded.quantity, recorded_at = now();

-- name: UsageTotals :many
SELECT meter, sum(quantity)::numeric AS quantity FROM usage_records
WHERE period >= @since AND period < @until GROUP BY meter ORDER BY meter;

-- name: UsageDaily :many
SELECT (date_trunc('day', period AT TIME ZONE 'UTC'))::date AS day, meter, sum(quantity)::numeric AS quantity FROM usage_records
WHERE period >= @since AND period < @until GROUP BY 1, 2 ORDER BY 1, 2;

-- name: UsageByRegion :many
SELECT region, meter, sum(quantity)::numeric AS quantity FROM usage_records
WHERE period >= @since AND period < @until AND region <> '' GROUP BY 1, 2 ORDER BY 1, 2;

-- A distribution's traffic since a time, from the CDN meters (keyed distribution|host|country|hour).
-- name: DistributionUsageSince :one
SELECT coalesce(sum(quantity), 0)::float8 FROM usage_records
WHERE meter = @meter AND key LIKE @distribution_prefix AND period >= @since;
