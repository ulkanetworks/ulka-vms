-- name: SourcesDueForDeletion :many
SELECT tenant_id::uuid, asset_id::uuid, source_key::text FROM sources_due_for_deletion(@max_rows);

-- name: ExpiredUploads :many
SELECT tenant_id::uuid, upload_id::uuid, asset_id::uuid FROM expired_uploads(@max_rows);

-- name: MarkSourceDeleted :exec
UPDATE assets SET source_deleted_at = now() WHERE id = @id;

-- name: ExpireUpload :execrows
UPDATE uploads SET status = 'expired' WHERE id = @id AND status IN ('waiting', 'uploading');

-- name: DeleteAsset :execrows
DELETE FROM assets WHERE id = @id;
