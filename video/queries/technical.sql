-- name: GetAssetTechnical :one
SELECT probe, plan, encryption_iv, source_deleted_at FROM assets WHERE id = @id;

