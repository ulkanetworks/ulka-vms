-- name: CreateUpload :one
INSERT INTO uploads DEFAULT VALUES RETURNING id, status, expires_at;

-- name: UploadState :one
-- store_id and size are empty until the first piece arrives.
SELECT s.tenant_id::uuid AS tenant_id, s.asset_id::uuid AS asset_id, s.status::text AS status,
    coalesce(s.store_id, '')::text AS store_id, coalesce(s.size, 0)::bigint AS size
FROM upload_state(@id) AS s;

-- name: UploadBegin :one
SELECT tenant_id::uuid, asset_id::uuid FROM upload_begin(@id, @store_id, @size);

-- name: LockUpload :one
SELECT id, asset_id, status, expires_at FROM uploads WHERE id = @id FOR UPDATE;

-- name: CompleteUpload :one
UPDATE uploads SET status = 'complete' WHERE asset_id = @asset_id RETURNING id;

-- name: CreateAsset :one
INSERT INTO assets (id, upload_id, status, passthrough, source_key, input_url, library_id, folder_id, title, playback_policy)
VALUES (@id, @upload_id, @status, @passthrough, @source_key, @input_url, @library_id, @folder_id, @title,
        coalesce(nullif(@playback_policy::text, ''), (SELECT default_playback_policy FROM libraries WHERE id = @library_id)))
RETURNING id, status, error_code, passthrough, duration_seconds, width, height, created_at, updated_at;

-- name: GetAsset :one
SELECT * FROM assets WHERE id = @id;

-- Searches the title, reference and id; status '' means any, or a comma-separated list of states. folder_mode: any (the whole library), root (Home only) or
-- folder (that folder). trashed picks the trash instead of the live videos.
-- Newest first, continuing after the (after_at, after_id) row: cursor pages stay right while videos are added.
-- name: ListAssets :many
SELECT * FROM assets
WHERE (@status::text = '' OR status = ANY(string_to_array(@status, ','))) AND (title ILIKE @pattern OR passthrough ILIKE @pattern OR description ILIKE @pattern OR id::text ILIKE @pattern)
  AND (@tag::text = '' OR @tag::text = ANY(tags))
  AND (@meta::jsonb = '[]'::jsonb OR metadata @> @meta::jsonb)
  AND (sqlc.narg(library_id)::uuid IS NULL OR library_id = sqlc.narg(library_id))
  AND (@folder_mode::text = 'any' OR (@folder_mode::text = 'root' AND folder_id IS NULL) OR (@folder_mode::text = 'folder' AND folder_id = sqlc.narg(folder_id)::uuid))
  AND ((@trashed::bool AND deleted_at IS NOT NULL) OR (NOT @trashed::bool AND deleted_at IS NULL))
  AND (@policy::text = '' OR assets.playback_policy = @policy::text)
  AND (sqlc.narg(after_at)::timestamptz IS NULL OR (created_at, id) < (sqlc.narg(after_at), sqlc.narg(after_id)::uuid))
ORDER BY created_at DESC, id DESC LIMIT @lim;

-- The same, oldest first (the cursor continues after the (after_at, after_id) row going forward).
-- name: ListAssetsOldest :many
SELECT * FROM assets
WHERE (@status::text = '' OR status = ANY(string_to_array(@status, ','))) AND (title ILIKE @pattern OR passthrough ILIKE @pattern OR description ILIKE @pattern OR id::text ILIKE @pattern)
  AND (@tag::text = '' OR @tag::text = ANY(tags))
  AND (@meta::jsonb = '[]'::jsonb OR metadata @> @meta::jsonb)
  AND (sqlc.narg(library_id)::uuid IS NULL OR library_id = sqlc.narg(library_id))
  AND (@folder_mode::text = 'any' OR (@folder_mode::text = 'root' AND folder_id IS NULL) OR (@folder_mode::text = 'folder' AND folder_id = sqlc.narg(folder_id)::uuid))
  AND ((@trashed::bool AND deleted_at IS NOT NULL) OR (NOT @trashed::bool AND deleted_at IS NULL))
  AND (@policy::text = '' OR assets.playback_policy = @policy::text)
  AND (sqlc.narg(after_at)::timestamptz IS NULL OR (created_at, id) > (sqlc.narg(after_at), sqlc.narg(after_id)::uuid))
ORDER BY created_at ASC, id ASC LIMIT @lim;

-- name: CountAssets :one
SELECT count(*) FROM assets
WHERE (@status::text = '' OR status = ANY(string_to_array(@status, ','))) AND (title ILIKE @pattern OR passthrough ILIKE @pattern OR description ILIKE @pattern OR id::text ILIKE @pattern)
  AND (@tag::text = '' OR @tag::text = ANY(tags))
  AND (@meta::jsonb = '[]'::jsonb OR metadata @> @meta::jsonb)
  AND (sqlc.narg(library_id)::uuid IS NULL OR library_id = sqlc.narg(library_id))
  AND (@folder_mode::text = 'any' OR (@folder_mode::text = 'root' AND folder_id IS NULL) OR (@folder_mode::text = 'folder' AND folder_id = sqlc.narg(folder_id)::uuid))
  AND ((@trashed::bool AND deleted_at IS NOT NULL) OR (NOT @trashed::bool AND deleted_at IS NULL))
  AND (@policy::text = '' OR assets.playback_policy = @policy::text);

-- name: StartAssetIfWaiting :one
UPDATE assets SET status = 'processing', updated_at = now()
WHERE id = @id AND status = 'waiting' RETURNING id;

-- name: SetAssetProbe :exec
UPDATE assets SET probe = @probe, duration_seconds = @duration_seconds, width = @width, height = @height,
    timeline = timeline || jsonb_build_object('checked', now()), updated_at = now()
WHERE id = @id;

-- name: CreateJob :one
INSERT INTO jobs (asset_id, type) VALUES (@asset_id, @type) RETURNING id;

-- name: IngestJobID :one
SELECT id FROM jobs WHERE asset_id = @asset_id AND type = 'ingest';

-- Each transition happens once, so its webhook fires once however many times a job retries.
-- name: StartJob :execrows
UPDATE jobs SET status = 'running', updated_at = now() WHERE id = @id AND status = 'queued';

-- name: FinishJob :execrows
UPDATE jobs SET status = @status, error_code = @error_code, updated_at = now()
WHERE id = @id AND status IN ('queued', 'running');

-- name: GetJob :one
SELECT id, asset_id, type, status, error_code, created_at, updated_at FROM jobs WHERE id = @id;

-- name: ListAssetJobs :many
SELECT id, asset_id, type, status, error_code, created_at, updated_at FROM jobs
WHERE asset_id = @asset_id ORDER BY created_at DESC;

-- name: GetVideoDelivery :one
SELECT mode, custom_url, provider, cdn_distribution_id FROM video_delivery WHERE tenant_id = current_tenant();

-- name: SetVideoDelivery :exec
INSERT INTO video_delivery (mode, custom_url, provider, cdn_distribution_id) VALUES (@mode, @custom_url, @provider, @cdn_distribution_id)
ON CONFLICT (tenant_id) DO UPDATE SET mode = excluded.mode, custom_url = excluded.custom_url, provider = excluded.provider,
    cdn_distribution_id = excluded.cdn_distribution_id, updated_at = now();

-- name: VideoStats :one
SELECT count(*) AS total,
    count(*) FILTER (WHERE status IN ('ready', 'complete')) AS playable,
    count(*) FILTER (WHERE status IN ('waiting', 'processing')) AS processing,
    count(*) FILTER (WHERE status = 'errored') AS failed,
    (coalesce(sum(duration_seconds) FILTER (WHERE status IN ('ready', 'complete')), 0) / 60)::float8 AS minutes
FROM assets WHERE deleted_at IS NULL;

-- name: SetAssetDownload :execrows
UPDATE assets SET download = @download, updated_at = now() WHERE id = @id;

-- A finished download lands only if it's still wanted: turning it off meanwhile leaves nothing to mark.
-- name: FinishAssetDownload :execrows
UPDATE assets SET download = @download, updated_at = now() WHERE id = @id AND download = 'preparing';

-- name: StoredMinutes :many
SELECT tenant_id::uuid, minutes::double precision FROM stored_minutes();

-- name: NoticeFailedVideos :one
SELECT count(*)::bigint AS n, max(updated_at)::timestamptz AS latest FROM assets
WHERE status = 'errored' AND updated_at > now() - interval '7 days';

-- Videos accepted but not finished: their minutes count once encoded.
-- name: PendingEncodeMinutes :one
SELECT coalesce(sum(duration_seconds) / 60, 0)::float8 FROM assets WHERE status IN ('processing', 'ready') AND id <> @exclude_asset;

-- A failed video whose original is still kept goes back to processing; no row otherwise.
-- name: RetryAsset :one
UPDATE assets SET status = 'processing', error_code = NULL, updated_at = now()
WHERE id = @id AND status = 'errored' AND deleted_at IS NULL AND source_deleted_at IS NULL RETURNING id;

-- name: RequeueIngestJob :execrows
UPDATE jobs SET status = 'queued', error_code = NULL, updated_at = now() WHERE asset_id = @asset_id AND type = 'ingest';

-- name: SetAssetDetails :exec
UPDATE assets SET description = coalesce(sqlc.narg(description)::text, description), tags = coalesce(sqlc.narg(tags)::text[], tags),
  metadata = coalesce(sqlc.narg(metadata)::jsonb, metadata), updated_at = now()
WHERE id = @id;

-- name: SetAssetChapters :exec
UPDATE assets SET chapters = @chapters::jsonb, updated_at = now() WHERE id = @id;

-- name: SetPosterFrame :one
-- A frame as the cover (NULL: the default frame); any uploaded picture stops being used.
UPDATE assets SET poster_time = sqlc.narg(poster_time), poster_uploaded_at = NULL, updated_at = now()
WHERE id = @id AND deleted_at IS NULL RETURNING id;

-- name: SetPosterUploaded :one
UPDATE assets SET poster_uploaded_at = now(), poster_time = NULL, updated_at = now()
WHERE id = @id AND deleted_at IS NULL RETURNING poster_uploaded_at;

-- name: StartTimeline :exec
-- Processing (re)starts: a fresh timeline, so a retry never shows the last attempt's stages.
UPDATE assets SET timeline = jsonb_build_object('received', now()) WHERE id = @id;
