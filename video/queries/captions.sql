-- Captions live on the video (assets.captions); these read and change that list in one statement each.

-- Adds a track unless the video already has max; no row means it's full.
-- name: CreateCaption :one
WITH n AS (SELECT gen_random_uuid() AS id, now() AS at)
UPDATE assets a SET captions = a.captions || jsonb_build_array(jsonb_build_object('id', n.id, 'language', @language::text,
    'name', @name::text, 'created_at', n.at))
FROM n WHERE a.id = @asset_id AND jsonb_array_length(a.captions) < @max::int
RETURNING n.id::uuid AS id, a.tenant_id::uuid AS tenant_id, a.id::uuid AS asset_id, @language::text AS language,
    @name::text AS name, n.at::timestamptz AS created_at;

-- name: ListCaptions :many
SELECT (c ->> 'id')::uuid AS id, a.tenant_id::uuid AS tenant_id, a.id::uuid AS asset_id, (c ->> 'language')::text AS language,
    (c ->> 'name')::text AS name, (c ->> 'created_at')::timestamptz AS created_at
FROM assets a, jsonb_array_elements(a.captions) c WHERE a.id = @asset_id ORDER BY created_at;

-- name: HasCaption :one
SELECT EXISTS (SELECT 1 FROM assets WHERE id = @asset_id AND captions @> jsonb_build_array(jsonb_build_object('id', @id::text)));

-- name: DeleteCaption :execrows
UPDATE assets SET captions = (SELECT coalesce(jsonb_agg(c ORDER BY ord), '[]') FROM jsonb_array_elements(captions) WITH ORDINALITY x(c, ord)
    WHERE c ->> 'id' <> @id::text)
WHERE id = @asset_id AND captions @> jsonb_build_array(jsonb_build_object('id', @id::text));
