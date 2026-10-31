-- The default library ("Main") exists for every workspace; this makes it for one made after the migration.
-- name: EnsureDefaultLibrary :one
INSERT INTO libraries (name, is_default) VALUES ('Main', true)
ON CONFLICT (tenant_id) WHERE is_default DO UPDATE SET name = libraries.name RETURNING id;

-- name: ListLibraries :many
SELECT l.id, l.name, l.description, l.is_default, l.default_playback_policy, l.preset_template, l.preset_id, l.mp4_downloads, l.allowed_domains, l.blocked_domains, l.country_mode, l.countries,
       l.player, l.inherits, l.created_at, l.updated_at,
       count(a.id) FILTER (WHERE a.deleted_at IS NULL)::int AS videos,
       count(a.id) FILTER (WHERE a.deleted_at IS NOT NULL)::int AS trashed,
       (coalesce(sum(a.duration_seconds) FILTER (WHERE a.deleted_at IS NULL), 0) / 60)::float8 AS minutes,
       -- Source sizes of the live videos whose original still exists (the probe holds ffprobe's size).
       coalesce(sum((a.probe->'format'->>'size')::bigint) FILTER (WHERE a.deleted_at IS NULL AND a.source_deleted_at IS NULL AND a.probe->'format'->>'size' ~ '^[0-9]+$'), 0)::bigint AS storage_bytes,
       count(a.id) FILTER (WHERE a.deleted_at IS NULL AND a.status = 'complete')::int AS ready_videos,
       count(a.id) FILTER (WHERE a.deleted_at IS NULL AND a.status IN ('waiting', 'processing', 'ready'))::int AS processing_videos,
       count(a.id) FILTER (WHERE a.deleted_at IS NULL AND a.status = 'errored')::int AS errored_videos
FROM libraries l LEFT JOIN assets a ON a.library_id = l.id
WHERE (sqlc.narg(id)::uuid IS NULL OR l.id = sqlc.narg(id))
GROUP BY l.id ORDER BY l.is_default DESC, l.created_at, l.id;

-- The console's list: searches the name and description, newest first, continuing after the (after_at, after_id) row.
-- name: ListLibrariesPage :many
SELECT l.id, l.name, l.description, l.is_default, l.default_playback_policy, l.preset_template, l.preset_id, l.mp4_downloads, l.allowed_domains, l.blocked_domains, l.country_mode, l.countries,
       l.player, l.inherits, l.created_at, l.updated_at,
       count(a.id) FILTER (WHERE a.deleted_at IS NULL)::int AS videos,
       count(a.id) FILTER (WHERE a.deleted_at IS NOT NULL)::int AS trashed,
       (coalesce(sum(a.duration_seconds) FILTER (WHERE a.deleted_at IS NULL), 0) / 60)::float8 AS minutes,
       -- Source sizes of the live videos whose original still exists (the probe holds ffprobe's size).
       coalesce(sum((a.probe->'format'->>'size')::bigint) FILTER (WHERE a.deleted_at IS NULL AND a.source_deleted_at IS NULL AND a.probe->'format'->>'size' ~ '^[0-9]+$'), 0)::bigint AS storage_bytes,
       count(a.id) FILTER (WHERE a.deleted_at IS NULL AND a.status = 'complete')::int AS ready_videos,
       count(a.id) FILTER (WHERE a.deleted_at IS NULL AND a.status IN ('waiting', 'processing', 'ready'))::int AS processing_videos,
       count(a.id) FILTER (WHERE a.deleted_at IS NULL AND a.status = 'errored')::int AS errored_videos
FROM libraries l LEFT JOIN assets a ON a.library_id = l.id
WHERE (l.name ILIKE @pattern OR l.description ILIKE @pattern)
  AND (sqlc.narg(after_at)::timestamptz IS NULL OR (l.created_at, l.id) < (sqlc.narg(after_at), sqlc.narg(after_id)::uuid))
GROUP BY l.id ORDER BY l.created_at DESC, l.id DESC LIMIT @lim;

-- name: CountLibraries :one
SELECT count(*) FROM libraries WHERE name ILIKE @pattern OR description ILIKE @pattern;

-- name: CreateLibrary :one
INSERT INTO libraries (name, description, player, preset_template, mp4_downloads, allowed_domains, blocked_domains, country_mode, countries, default_playback_policy)
SELECT @name, @description, d.player, d.preset_template, d.mp4_downloads, d.allowed_domains, d.blocked_domains, d.country_mode, d.countries, d.default_playback_policy
FROM video_defaults d RETURNING id;

-- Null leaves a setting as it is.
-- name: UpdateLibrary :one
UPDATE libraries SET
    name = coalesce(sqlc.narg(name), name),
    description = coalesce(sqlc.narg(description), description),
    default_playback_policy = coalesce(sqlc.narg(default_playback_policy), default_playback_policy),
    mp4_downloads = coalesce(sqlc.narg(mp4_downloads)::bool, mp4_downloads),
    allowed_domains = coalesce(sqlc.narg(allowed_domains)::text[], allowed_domains),
    blocked_domains = coalesce(sqlc.narg(blocked_domains)::text[], blocked_domains),
    country_mode = coalesce(sqlc.narg(country_mode)::text, country_mode),
    countries = coalesce(sqlc.narg(countries)::text[], countries),
    inherits = ARRAY(SELECT g FROM unnest(inherits) g WHERE g <> ALL(@drop::text[])),
    updated_at = now()
WHERE id = @id RETURNING id;

-- Copies the workspace defaults of the groups in apply into the library and makes it follow them.
-- name: ApplyLibraryDefaults :execrows
UPDATE libraries l SET
    player = CASE WHEN 'player' = ANY(@apply::text[]) THEN d.player ELSE l.player END,
    preset_template = CASE WHEN 'transcoding' = ANY(@apply::text[]) THEN d.preset_template ELSE l.preset_template END,
    preset_id = CASE WHEN 'transcoding' = ANY(@apply::text[]) THEN NULL ELSE l.preset_id END,
    mp4_downloads = CASE WHEN 'transcoding' = ANY(@apply::text[]) THEN d.mp4_downloads ELSE l.mp4_downloads END,
    allowed_domains = CASE WHEN 'security' = ANY(@apply::text[]) THEN d.allowed_domains ELSE l.allowed_domains END,
    blocked_domains = CASE WHEN 'security' = ANY(@apply::text[]) THEN d.blocked_domains ELSE l.blocked_domains END,
    country_mode = CASE WHEN 'security' = ANY(@apply::text[]) THEN d.country_mode ELSE l.country_mode END,
    countries = CASE WHEN 'security' = ANY(@apply::text[]) THEN d.countries ELSE l.countries END,
    default_playback_policy = CASE WHEN 'security' = ANY(@apply::text[]) THEN d.default_playback_policy ELSE l.default_playback_policy END,
    inherits = ARRAY(SELECT g FROM unnest(ARRAY['player', 'transcoding', 'security']) g WHERE g = ANY(l.inherits) OR g = ANY(@apply::text[])),
    updated_at = now()
FROM video_defaults d WHERE l.id = @id;

-- name: EnsureVideoDefaults :exec
INSERT INTO video_defaults DEFAULT VALUES ON CONFLICT DO NOTHING;

-- name: GetVideoDefaults :one
SELECT player, preset_template, mp4_downloads, allowed_domains, blocked_domains, country_mode, countries, default_playback_policy FROM video_defaults;

-- Null leaves a default as it is.
-- name: UpdateVideoDefaults :exec
UPDATE video_defaults SET
    player = coalesce(sqlc.narg(player)::jsonb, player),
    preset_template = coalesce(sqlc.narg(preset_template), preset_template),
    mp4_downloads = coalesce(sqlc.narg(mp4_downloads)::bool, mp4_downloads),
    allowed_domains = coalesce(sqlc.narg(allowed_domains)::text[], allowed_domains),
    blocked_domains = coalesce(sqlc.narg(blocked_domains)::text[], blocked_domains),
    country_mode = coalesce(sqlc.narg(country_mode)::text, country_mode),
    countries = coalesce(sqlc.narg(countries)::text[], countries),
    default_playback_policy = coalesce(sqlc.narg(default_playback_policy), default_playback_policy),
    updated_at = now();

-- Pushes the defaults into every library, group by group, where the library follows that group.
-- name: PropagateVideoDefaults :exec
UPDATE libraries l SET
    player = CASE WHEN 'player' = ANY(l.inherits) THEN d.player ELSE l.player END,
    preset_template = CASE WHEN 'transcoding' = ANY(l.inherits) THEN d.preset_template ELSE l.preset_template END,
    preset_id = CASE WHEN 'transcoding' = ANY(l.inherits) THEN NULL ELSE l.preset_id END,
    mp4_downloads = CASE WHEN 'transcoding' = ANY(l.inherits) THEN d.mp4_downloads ELSE l.mp4_downloads END,
    allowed_domains = CASE WHEN 'security' = ANY(l.inherits) THEN d.allowed_domains ELSE l.allowed_domains END,
    blocked_domains = CASE WHEN 'security' = ANY(l.inherits) THEN d.blocked_domains ELSE l.blocked_domains END,
    country_mode = CASE WHEN 'security' = ANY(l.inherits) THEN d.country_mode ELSE l.country_mode END,
    countries = CASE WHEN 'security' = ANY(l.inherits) THEN d.countries ELSE l.countries END,
    default_playback_policy = CASE WHEN 'security' = ANY(l.inherits) THEN d.default_playback_policy ELSE l.default_playback_policy END,
    updated_at = now()
FROM video_defaults d WHERE cardinality(l.inherits) > 0;

-- name: SetLibraryPlayer :execrows
UPDATE libraries SET player = @player, inherits = array_remove(inherits, 'player'), updated_at = now() WHERE id = @id;

-- name: LibraryAssetCount :one
SELECT count(*)::int FROM assets WHERE library_id = @id;

-- name: DeleteLibrary :execrows
DELETE FROM libraries WHERE id = @id AND NOT is_default;

-- name: ListFolders :many
SELECT f.id, f.library_id, f.parent_id, f.name, f.created_at, f.updated_at,
       (SELECT count(*) FROM assets a WHERE a.folder_id = f.id AND a.deleted_at IS NULL)::int AS videos
FROM folders f WHERE f.library_id = @library_id ORDER BY lower(f.name), f.id;

-- name: GetFolder :one
SELECT id, library_id, parent_id, name FROM folders WHERE id = @id;

-- name: CreateFolder :one
INSERT INTO folders (library_id, parent_id, name) VALUES (@library_id, @parent_id, @name) RETURNING id;

-- name: RenameFolder :execrows
UPDATE folders SET name = @name, updated_at = now() WHERE id = @id;

-- name: MoveFolder :execrows
UPDATE folders SET parent_id = @parent_id, updated_at = now() WHERE id = @id;

-- A folder and everything under it.
-- name: FolderSubtree :many
WITH RECURSIVE sub AS (
    SELECT f0.id FROM folders f0 WHERE f0.id = @id
    UNION ALL SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id
) SELECT sub.id FROM sub;

-- name: TrashAssetsInFolders :execrows
UPDATE assets SET deleted_at = now(), updated_at = now() WHERE folder_id = ANY(@folder_ids::uuid[]) AND deleted_at IS NULL;

-- name: DeleteFolder :execrows
DELETE FROM folders WHERE id = @id;

-- name: TrashAssets :execrows
UPDATE assets SET deleted_at = now(), updated_at = now() WHERE id = ANY(@ids::uuid[]) AND deleted_at IS NULL;

-- name: RestoreAssets :execrows
UPDATE assets SET deleted_at = NULL, updated_at = now() WHERE id = ANY(@ids::uuid[]) AND deleted_at IS NOT NULL;

-- name: MoveAssets :execrows
UPDATE assets SET library_id = @library_id, folder_id = @folder_id, updated_at = now() WHERE id = ANY(@ids::uuid[]) AND deleted_at IS NULL;

-- name: SetAssetTitle :execrows
UPDATE assets SET title = @title, updated_at = now() WHERE id = @id AND deleted_at IS NULL;

-- The preset a video is encoded with: the library's custom one, else its template (heights and quality null).
-- name: AssetPreset :one
SELECT l.preset_template, p.heights, p.quality FROM assets a JOIN libraries l ON l.id = a.library_id
LEFT JOIN transcoding_presets p ON p.id = l.preset_id WHERE a.id = @id;

-- name: LibraryDefaults :one
SELECT default_playback_policy, mp4_downloads FROM libraries WHERE id = @id;

-- name: TrashedDue :many
SELECT tenant_id::uuid, asset_id::uuid FROM trashed_due_for_purge(@days::int);

-- What the player needs: the video's library settings, looked up through its asset.
-- name: PlayerLibrary :one
SELECT l.id, l.name, l.allowed_domains, l.blocked_domains, l.country_mode, l.countries, l.player FROM assets a JOIN libraries l ON l.id = a.library_id WHERE a.id = @id;

-- name: ListPresets :many
SELECT id, library_id, name, description, heights, quality, created_at, updated_at FROM transcoding_presets
WHERE library_id = @library_id ORDER BY lower(name), id;

-- name: GetPreset :one
SELECT id, library_id, name, description, heights, quality FROM transcoding_presets WHERE id = @id;

-- name: CreatePreset :one
INSERT INTO transcoding_presets (library_id, name, description, heights, quality)
VALUES (@library_id, @name, @description, @heights, @quality) RETURNING id;

-- Null leaves a field as it is.
-- name: UpdatePreset :execrows
UPDATE transcoding_presets SET name = coalesce(sqlc.narg(name), name), description = coalesce(sqlc.narg(description), description),
    heights = coalesce(sqlc.narg(heights)::int[], heights), quality = coalesce(sqlc.narg(quality), quality), updated_at = now()
WHERE id = @id;

-- name: DeletePreset :execrows
DELETE FROM transcoding_presets WHERE id = @id;

-- name: SetLibraryPreset :execrows
UPDATE libraries SET preset_template = @preset_template, preset_id = @preset_id, inherits = array_remove(inherits, 'transcoding'), updated_at = now() WHERE id = @id;

-- name: PresetInUse :one
SELECT EXISTS (SELECT 1 FROM libraries WHERE preset_id = @id);
