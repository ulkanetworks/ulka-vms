-- RLS applies the tenant filter from app.tenant_id. Tables a user also sees across tenants (tenants, tenant_members,
-- users, sessions) need an explicit filter: with app.user_id set, RLS alone returns more than one tenant's rows.

-- name: Signup :one
SELECT tenant_id::uuid, user_id::uuid FROM signup(@email, @password_hash, @tenant_name, @name);

-- name: LoginLookup :one
SELECT user_id::uuid, password_hash::text, tenant_id::uuid FROM login_lookup(@email);

-- name: SessionLookup :one
SELECT user_id::uuid, tenant_id::uuid, role::text, acting_admin_id::uuid, coalesce(acting_admin_name, '')::text AS acting_admin_name,
       expires_at::timestamptz FROM session_lookup(@token_hash);

-- name: APIKeyLookup :one
SELECT id::uuid, tenant_id::uuid, scopes::text[], allowed_ips::cidr[] FROM api_key_lookup(@key_hash);

-- name: APIKeyUsed :exec
SELECT api_key_used(@id)::text;

-- name: GetTenant :one
SELECT id, name, created_at FROM tenants WHERE id = current_tenant();

-- name: GetUser :one
SELECT id, email, name FROM users WHERE id = @id;

-- name: CreateSession :exec
INSERT INTO sessions (token_hash, user_id, expires_at, created_ip, user_agent)
VALUES (@token_hash, @user_id, @expires_at, sqlc.narg(created_ip)::inet, left(@user_agent::text, 512));

-- A session an Ulka admin uses as the person, with the visit the workspace sees, in the tenant's scope.
-- name: CreateActingSession :exec
INSERT INTO sessions (token_hash, user_id, expires_at, created_ip, user_agent, acting_admin_id, acting_admin_name)
VALUES (@token_hash, @user_id, @expires_at, sqlc.narg(created_ip)::inet, left(@user_agent::text, 512), @admin_id, @admin_name);

-- Trades a support session's one-time code for a new token, once; no row when the code is unknown, used or older than two minutes.
-- name: ActingHandoff :one
SELECT acting_handoff(@old_hash, @new_hash)::timestamptz AS expires_at;

-- name: InsertSupportVisit :exec
INSERT INTO support_visits (user_id, admin_id, admin_name, reason, expires_at) VALUES (@user_id, @admin_id, @admin_name, @reason, @expires_at);

-- Visits in the last 7 days, newest first, with the person used.
-- name: RecentSupportVisits :many
SELECT v.id, v.admin_name, v.reason, v.started_at, v.expires_at, u.email, coalesce(u.name, '')::text AS user_name
FROM support_visits v JOIN users u ON u.id = v.user_id
WHERE v.started_at > now() - interval '7 days' ORDER BY v.started_at DESC LIMIT 20;

-- name: DeleteSession :exec
DELETE FROM sessions WHERE token_hash = @token_hash;

-- name: CreateAPIKey :one
INSERT INTO api_keys (name, prefix, key_hash, scopes, allowed_ips, expires_at)
VALUES (@name, @prefix, @key_hash, @scopes, @allowed_ips, @expires_at)
RETURNING id, name, prefix, scopes, allowed_ips, expires_at, last_used_at, created_at;

-- Searches the name and prefix. Newest first, continuing after the (after_at, after_id) row.
-- name: GetAPIKey :one
SELECT id, name, prefix, scopes, allowed_ips, expires_at, last_used_at, created_at FROM api_keys WHERE id = @id;

-- name: ListAPIKeys :many
SELECT id, name, prefix, scopes, allowed_ips, expires_at, last_used_at, created_at FROM api_keys
WHERE (name ILIKE @pattern OR prefix ILIKE @pattern)
  AND (sqlc.narg(after_at)::timestamptz IS NULL OR (created_at, id) < (sqlc.narg(after_at), sqlc.narg(after_id)::uuid))
ORDER BY created_at DESC, id DESC LIMIT @lim;

-- name: CountAPIKeys :one
SELECT count(*) FROM api_keys WHERE name ILIKE @pattern OR prefix ILIKE @pattern;

-- name: DeleteAPIKey :execrows
DELETE FROM api_keys WHERE id = @id;

-- name: GetUserAccount :one
SELECT id, email, name, phone, locale, timezone, email_verified_at, last_login_at, created_at FROM users WHERE id = current_app_user();

-- name: GetUserPasswordHash :one
SELECT password_hash FROM users WHERE id = current_app_user();

-- name: UpdateUserName :exec
UPDATE users SET name = nullif(@name::text, ''), updated_at = now() WHERE id = current_app_user();

-- name: UpdateUserContact :exec
UPDATE users SET phone = sqlc.narg(phone), locale = @locale, timezone = sqlc.narg(timezone), updated_at = now() WHERE id = current_app_user();

-- name: UpdateUserPassword :exec
UPDATE users SET password_hash = @password_hash WHERE id = current_app_user();

-- name: SetUserEmail :exec
UPDATE users SET email = @email, email_verified_at = now() WHERE id = current_app_user();

-- name: MarkEmailVerified :execrows
UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = current_app_user() AND lower(email) = lower(@email);

-- name: UserIDByEmail :one
SELECT user_id_by_email(@email)::uuid;

-- name: DeleteOtherSessions :execrows
DELETE FROM sessions WHERE user_id = current_app_user() AND token_hash <> @keep;

-- name: DeleteAllSessions :exec
DELETE FROM sessions WHERE user_id = current_app_user();

-- name: SwitchSessionTenant :execrows
UPDATE sessions SET tenant_id = @tenant_id
WHERE token_hash = @token_hash AND EXISTS (
    SELECT 1 FROM tenant_members m JOIN tenants t ON t.id = m.tenant_id
    WHERE m.tenant_id = @tenant_id AND m.user_id = current_app_user() AND t.suspended_at IS NULL);

-- name: MyTenants :many
SELECT t.id, t.name, m.role, t.suspended_at, m.created_at AS joined_at
FROM tenant_members m JOIN tenants t ON t.id = m.tenant_id
WHERE m.user_id = current_app_user() ORDER BY m.created_at;

-- name: CreateTenant :exec
INSERT INTO tenants (id, name) VALUES (current_tenant(), @name);

-- name: RenameTenant :exec
UPDATE tenants SET name = @name WHERE id = current_tenant();

-- name: AddMember :exec
INSERT INTO tenant_members (user_id, role) VALUES (@user_id, @role)
ON CONFLICT (tenant_id, user_id) DO NOTHING;

-- name: MemberRole :one
SELECT role FROM tenant_members WHERE tenant_id = current_tenant() AND user_id = @user_id;

-- Searches the email and name. Newest first, continuing after the (after_at, after_id) row.
-- name: ListMembers :many
SELECT u.id, u.email, u.name, m.role, m.created_at AS joined_at
FROM tenant_members m JOIN users u ON u.id = m.user_id
WHERE m.tenant_id = current_tenant() AND (u.email ILIKE @pattern OR u.name ILIKE @pattern)
  AND (sqlc.narg(after_at)::timestamptz IS NULL OR (m.created_at, u.id) < (sqlc.narg(after_at), sqlc.narg(after_id)::uuid))
ORDER BY m.created_at DESC, u.id DESC LIMIT @lim;

-- name: CountMembers :one
SELECT count(*) FROM tenant_members m JOIN users u ON u.id = m.user_id
WHERE m.tenant_id = current_tenant() AND (u.email ILIKE @pattern OR u.name ILIKE @pattern);

-- name: CountOwners :one
SELECT count(*) FROM tenant_members WHERE tenant_id = current_tenant() AND role = 'owner';

-- name: SetMemberRole :execrows
UPDATE tenant_members SET role = @role WHERE tenant_id = current_tenant() AND user_id = @user_id;

-- name: RemoveMember :execrows
DELETE FROM tenant_members WHERE tenant_id = current_tenant() AND user_id = @user_id;

-- name: DeleteMemberSessions :exec
DELETE FROM sessions WHERE tenant_id = current_tenant() AND user_id = @user_id;

-- name: UpsertInvite :one
INSERT INTO invites (email, role, token_hash, invited_by, expires_at) VALUES (@email, @role, @token_hash, @invited_by, @expires_at)
ON CONFLICT (tenant_id, lower(email)) DO UPDATE
    SET role = excluded.role, token_hash = excluded.token_hash, invited_by = excluded.invited_by,
        created_at = now(), expires_at = excluded.expires_at
RETURNING id, email, role, created_at, expires_at;

-- Searches the email. Newest first, continuing after the (after_at, after_id) row.
-- name: ListInvites :many
SELECT id, email, role, created_at, expires_at FROM invites WHERE expires_at > now() AND email ILIKE @pattern
  AND (sqlc.narg(after_at)::timestamptz IS NULL OR (created_at, id) < (sqlc.narg(after_at), sqlc.narg(after_id)::uuid))
ORDER BY created_at DESC, id DESC LIMIT @lim;

-- name: CountInvites :one
SELECT count(*) FROM invites WHERE expires_at > now() AND email ILIKE @pattern;

-- name: DeleteInvite :execrows
DELETE FROM invites WHERE id = @id;

-- name: InviteLookup :one
SELECT id::uuid, tenant_id::uuid, tenant_name::text, email::text, role::text, account_exists::bool FROM invite_lookup(@token_hash);

-- name: CreateInvitedUser :one
SELECT create_invited_user(@email, @password_hash, @name)::uuid;

-- name: IsMemberEmail :one
SELECT exists(SELECT 1 FROM tenant_members m JOIN users u ON u.id = m.user_id
    WHERE m.tenant_id = current_tenant() AND lower(u.email) = lower(@email));

-- name: CreateEmailToken :exec
INSERT INTO email_tokens (token_hash, user_id, purpose, email, expires_at)
VALUES (@token_hash, current_app_user(), @purpose, @email, @expires_at);

-- name: RecentEmailToken :one
SELECT exists(SELECT 1 FROM email_tokens WHERE user_id = current_app_user() AND purpose = @purpose
    AND created_at > now() - interval '1 minute');

-- name: EmailTokenLookup :one
SELECT user_id::uuid, email::text FROM email_token_lookup(@token_hash, @purpose);

-- name: DeleteEmailTokens :exec
DELETE FROM email_tokens WHERE user_id = current_app_user() AND purpose = @purpose;

-- name: LoginBlocked :one
SELECT login_blocked(@email)::bool;

-- name: LoginFailed :exec
SELECT login_failed(@email);

-- name: LoginSucceeded :exec
SELECT login_succeeded(@email);

-- name: NoticeExpiringKeys :many
SELECT id, name, expires_at::timestamptz FROM api_keys
WHERE expires_at IS NOT NULL AND expires_at < now() + interval '7 days' ORDER BY expires_at;

-- name: RetentionCore :many
SELECT tbl::text, deleted::bigint FROM retention_core();

-- name: SessionSeen :exec
SELECT session_seen(@token_hash);

-- name: UserSignedIn :exec
SELECT user_signed_in(@user_id);

-- Where the caller is signed in, most recently used first.
-- name: ListMySessions :many
SELECT token_hash, created_at, last_seen_at, host(created_ip)::text AS ip, coalesce(user_agent, '') AS user_agent,
       coalesce(acting_admin_name, '')::text AS acting_admin_name
FROM sessions WHERE user_id = current_app_user() AND expires_at > now() ORDER BY last_seen_at DESC LIMIT 50;
