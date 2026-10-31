-- name: AddPlaybackReport :exec
INSERT INTO playback_reports (asset_id, code, ip, country, user_agent, plays, results)
VALUES (@asset_id, @code, @ip, @country, @user_agent, @plays, @results);

-- name: RecentPlaybackReport :one
SELECT EXISTS (SELECT 1 FROM playback_reports WHERE asset_id = @asset_id AND ip = @ip AND created_at > now() - interval '30 seconds');

-- name: ListPlaybackReports :many
SELECT code, ip, country, user_agent, plays, results, created_at FROM playback_reports
WHERE asset_id = @asset_id AND (sqlc.narg(after_at)::timestamptz IS NULL OR (created_at, code) < (sqlc.narg(after_at), sqlc.narg(after_code)::text))
ORDER BY created_at DESC, code DESC LIMIT @lim;

-- name: CountPlaybackReports :one
SELECT count(*) FROM playback_reports WHERE asset_id = @asset_id;

-- name: ExpirePlaybackReports :one
SELECT playback_reports_expire();

-- name: GetPlaybackReport :one
SELECT r.code, r.asset_id, a.title, r.ip, r.country, r.user_agent, r.plays, r.results, r.created_at
FROM playback_reports r JOIN assets a ON a.id = r.asset_id WHERE r.code = upper(@code::text);
