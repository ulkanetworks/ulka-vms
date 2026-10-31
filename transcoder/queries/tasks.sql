-- name: CreateEncodeTask :exec
INSERT INTO encode_tasks (asset_id, job_id, lane, chunk) VALUES (@asset_id, @job_id, @lane, @chunk) ON CONFLICT DO NOTHING;

-- Finishers of one video's pieces take turns, so the last one to finish is the only one to queue packaging.
-- name: LockTasks :one
SELECT count(*)::int FROM (SELECT 1 FROM encode_tasks WHERE asset_id = @asset_id FOR UPDATE) t;

-- name: CompleteEncodeTask :one
UPDATE encode_tasks SET done = true, done_at = now()
WHERE asset_id = @asset_id AND lane = @lane AND chunk = @chunk AND NOT done
RETURNING lane;

-- name: EncodeTasksLeft :one
SELECT count(*) FILTER (WHERE NOT done AND lane IN ('fast', 'audio'))::int AS playable_left,
       count(*) FILTER (WHERE NOT done)::int AS all_left
FROM encode_tasks WHERE asset_id = @asset_id;

-- A video that failed has no more work to hand out.
-- name: WriteOffTasks :exec
UPDATE encode_tasks SET failed_at = now() WHERE asset_id = @asset_id AND NOT done AND failed_at IS NULL;

-- name: TaskProgress :many
SELECT asset_id, lane, count(*) FILTER (WHERE done)::int AS done, count(*)::int AS total,
       coalesce(sum(progress) FILTER (WHERE NOT done AND node_id IS NOT NULL AND leased_until > now()), 0)::float8 AS partial
FROM encode_tasks WHERE asset_id = ANY(@asset_ids::uuid[]) GROUP BY asset_id, lane;

-- name: ListEncodeTasks :many
SELECT lane, chunk, done, attempts, coalesce(node_id, '')::text AS node, progress, coalesce(last_error, '')::text AS last_error,
       created_at, started_at, done_at,
       (CASE WHEN done THEN 'done' WHEN failed_at IS NOT NULL THEN 'failed' WHEN node_id IS NOT NULL AND leased_until > now() THEN 'running' WHEN attempts > 0 THEN 'retrying' ELSE 'queued' END)::text AS state
FROM encode_tasks WHERE asset_id = @asset_id ORDER BY lane, chunk;

-- name: DeleteEncodeTasks :exec
DELETE FROM encode_tasks WHERE asset_id = @asset_id;
