-- name: SetAssetPlan :exec
UPDATE assets SET plan = @plan, encryption_key = @encryption_key, encryption_iv = @encryption_iv, updated_at = now()
WHERE id = @id;

-- name: LockAsset :one
SELECT status FROM assets WHERE id = @id FOR UPDATE;

-- name: MarkAssetReady :execrows
UPDATE assets SET status = 'ready', timeline = timeline || jsonb_build_object('playable', now()), updated_at = now()
WHERE id = @id AND status = 'processing';

-- name: MarkAssetComplete :execrows
-- Straight to complete also became playable now; an earlier playable time stays.
UPDATE assets SET status = 'complete', timeline = jsonb_build_object('playable', now()) || timeline || jsonb_build_object('complete', now()),
    updated_at = now()
WHERE id = @id AND status IN ('processing', 'ready');

-- A failure errors the asset only while nothing is playable; a ready asset keeps playing.
-- name: FailAssetIfUnplayable :execrows
UPDATE assets SET status = 'errored', error_code = @error_code, timeline = timeline || jsonb_build_object('failed', now()), updated_at = now()
WHERE id = @id AND status IN ('waiting', 'processing');

-- name: GetAssetWork :one
SELECT source_key, plan, duration_seconds, encryption_key, encryption_iv FROM assets WHERE id = @id;
