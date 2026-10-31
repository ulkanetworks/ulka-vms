-- name: VideoLookup :one
SELECT tenant_id::uuid, policy::text FROM video_lookup(@library_id, @video_id);

-- name: PlaybackAsset :one
SELECT status, encryption_key, plan, duration_seconds, download, passthrough, poster_time, poster_uploaded_at FROM assets WHERE id = @id;

-- name: CreateSigningKey :one
INSERT INTO signing_keys (secret) VALUES (@secret) RETURNING id, created_at;

-- name: ListSigningKeys :many
SELECT id, created_at FROM signing_keys
WHERE id::text ILIKE @pattern::text AND (sqlc.narg(after_at)::timestamptz IS NULL OR (created_at, id) < (sqlc.narg(after_at), sqlc.narg(after_id)::uuid))
ORDER BY created_at DESC, id DESC LIMIT @lim;

-- name: CountSigningKeys :one
SELECT count(*) FROM signing_keys WHERE id::text ILIKE @pattern::text;

-- name: DeleteSigningKey :execrows
DELETE FROM signing_keys WHERE id = @id;

-- name: LatestSigningKey :one
SELECT id, secret FROM signing_keys ORDER BY created_at DESC LIMIT 1;

-- name: GetSigningSecret :one
SELECT secret FROM signing_keys WHERE id = @id;

-- name: SetPlaybackPolicy :exec
UPDATE assets SET playback_policy = @policy WHERE id = @id;
