-- name: CreateWebhookEndpoint :one
INSERT INTO webhook_endpoints (name, url, secret, events) VALUES (@name, @url, @secret, @events::text[])
RETURNING id, name, url, events, enabled, created_at;

-- Changes only what's given.
-- name: UpdateWebhookEndpoint :one
UPDATE webhook_endpoints SET name = coalesce(sqlc.narg(name), name), url = coalesce(sqlc.narg(url), url),
    events = coalesce(sqlc.narg(events)::text[], events), enabled = coalesce(sqlc.narg(enabled), enabled)
WHERE id = @id RETURNING id, name, url, events, enabled, created_at;

-- name: ShowWebhookEndpoint :one
SELECT id, name, url, events, enabled, created_at FROM webhook_endpoints WHERE id = @id;

-- name: ListWebhookEndpoints :many
SELECT id, name, url, events, enabled, created_at FROM webhook_endpoints
WHERE (url ILIKE @pattern OR name ILIKE @pattern) AND (sqlc.narg(after_at)::timestamptz IS NULL OR (created_at, id) < (sqlc.narg(after_at), sqlc.narg(after_id)::uuid))
ORDER BY created_at DESC, id DESC LIMIT @lim;

-- name: CountWebhookEndpoints :one
SELECT count(*) FROM webhook_endpoints WHERE url ILIKE @pattern OR name ILIKE @pattern;

-- name: DeleteWebhookEndpoint :execrows
DELETE FROM webhook_endpoints WHERE id = @id;

-- The endpoints an event goes to: switched on, and wanting every event or this one.
-- name: WebhookEndpointIDs :many
SELECT id FROM webhook_endpoints WHERE enabled AND (cardinality(events) = 0 OR @event::text = ANY(events));

-- name: GetWebhookEndpoint :one
SELECT url, secret FROM webhook_endpoints WHERE id = @id;

-- name: CreateDelivery :one
INSERT INTO webhook_deliveries (endpoint_id, event, body) VALUES (@endpoint_id, @event, @body) RETURNING id;

-- The attempt's outcome. The count rises on each try, also after a manual retry.
-- name: RecordDelivery :exec
UPDATE webhook_deliveries SET status = @status, status_code = sqlc.narg(status_code), failure = sqlc.narg(failure),
    attempts = attempts + 1, attempted_at = now(), next_attempt_at = sqlc.narg(next_attempt_at)
WHERE id = @id;

-- A job that stopped for good, or was never sent.
-- name: FailDelivery :exec
UPDATE webhook_deliveries SET status = 'failed', failure = @failure, next_attempt_at = NULL WHERE id = @id;

-- name: ListDeliveriesPage :many
SELECT id, event, status, status_code, attempts, coalesce(failure, '')::text AS failure, created_at, attempted_at, next_attempt_at
FROM webhook_deliveries
WHERE endpoint_id = @endpoint_id AND (sqlc.narg(after_at)::timestamptz IS NULL OR (created_at, id) < (sqlc.narg(after_at), sqlc.narg(after_id)::uuid))
ORDER BY created_at DESC, id DESC LIMIT @lim;

-- name: CountDeliveries :one
SELECT count(*) FROM webhook_deliveries WHERE endpoint_id = @endpoint_id;

-- name: EndpointExists :one
SELECT EXISTS (SELECT 1 FROM webhook_endpoints WHERE id = @id);

-- Puts a failed delivery back in the queue; no row when it wasn't failed.
-- name: RequeueDelivery :one
UPDATE webhook_deliveries SET status = 'pending', failure = NULL, next_attempt_at = NULL
WHERE id = @id AND endpoint_id = @endpoint_id AND status = 'failed' RETURNING id, body;

-- name: GetDeliveryStatus :one
SELECT status FROM webhook_deliveries WHERE id = @id AND endpoint_id = @endpoint_id;

-- name: RetentionWebhooks :one
SELECT retention_webhooks()::bigint;
