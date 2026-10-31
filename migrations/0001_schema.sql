-- ulka-vms schema. Every tenant table has row-level security on current_tenant(); the app connects as ulka_app.
SET LOCAL check_function_bodies = false;

-- Who is asking: set per transaction by core.InTenant and core.InScope.
CREATE FUNCTION current_tenant() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION current_app_user() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- tenants
CREATE TABLE tenants (
    id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    suspended_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    limits jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT tenants_limits_check CHECK (((jsonb_typeof(limits) = 'object'::text) AND (COALESCE(((limits ->> 'max_upload_bytes'::text))::bigint, (1)::bigint) > 0) AND (COALESCE(((limits ->> 'encode_minutes_monthly'::text))::integer, 0) >= 0) )),
    CONSTRAINT tenants_name_check CHECK (((length(name) >= 1) AND (length(name) <= 100)))
);

ALTER TABLE ONLY tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);

CREATE INDEX tenants_created_id_idx ON tenants USING btree (created_at DESC, id DESC);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

GRANT SELECT,INSERT ON TABLE tenants TO ulka_app;

GRANT UPDATE(name) ON TABLE tenants TO ulka_app;

-- users
CREATE TABLE users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    name text,
    email_verified_at timestamp with time zone,
    phone text,
    locale text DEFAULT 'en'::text NOT NULL,
    last_login_at timestamp with time zone,
    disabled_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    timezone text,
    CONSTRAINT users_locale_check CHECK ((locale = ANY (ARRAY['en'::text, 'bn'::text]))),
    CONSTRAINT users_name_check CHECK (((length(name) >= 1) AND (length(name) <= 100))),
    CONSTRAINT users_phone_check CHECK ((phone ~ '^\+[1-9][0-9]{6,14}$'::text)),
    CONSTRAINT users_timezone_check CHECK (((timezone IS NULL) OR ((length(timezone) >= 1) AND (length(timezone) <= 64))))
);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

CREATE INDEX users_created_id_idx ON users USING btree (created_at DESC, id DESC);

CREATE UNIQUE INDEX users_email_key ON users USING btree (lower(email));

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON TABLE users TO ulka_app;

GRANT UPDATE(email) ON TABLE users TO ulka_app;

GRANT UPDATE(password_hash) ON TABLE users TO ulka_app;

GRANT UPDATE(name) ON TABLE users TO ulka_app;

GRANT UPDATE(email_verified_at) ON TABLE users TO ulka_app;

GRANT UPDATE(phone) ON TABLE users TO ulka_app;

GRANT UPDATE(locale) ON TABLE users TO ulka_app;

GRANT UPDATE(updated_at) ON TABLE users TO ulka_app;

GRANT UPDATE(timezone) ON TABLE users TO ulka_app;

-- tenant_members
CREATE TABLE tenant_members (
    tenant_id uuid DEFAULT current_tenant() NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text, 'viewer'::text])))
);

ALTER TABLE ONLY tenant_members
    ADD CONSTRAINT tenant_members_pkey PRIMARY KEY (tenant_id, user_id);

CREATE INDEX tenant_members_user_idx ON tenant_members USING btree (user_id);

ALTER TABLE tenant_members ENABLE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,DELETE ON TABLE tenant_members TO ulka_app;

GRANT UPDATE(role) ON TABLE tenant_members TO ulka_app;

-- sessions
CREATE TABLE sessions (
    token_hash bytea NOT NULL,
    tenant_id uuid DEFAULT current_tenant() NOT NULL,
    user_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_ip inet,
    user_agent text,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    acting_admin_id uuid,
    acting_admin_name text,
    CONSTRAINT sessions_acting_admin_name_check CHECK ((length(acting_admin_name) <= 100)),
    CONSTRAINT sessions_user_agent_check CHECK ((length(user_agent) <= 512))
);

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (token_hash);

CREATE INDEX sessions_user_idx ON sessions USING btree (user_id);

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,DELETE ON TABLE sessions TO ulka_app;

GRANT UPDATE(tenant_id) ON TABLE sessions TO ulka_app;

-- api_keys
CREATE TABLE api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid DEFAULT current_tenant() NOT NULL,
    name text NOT NULL,
    prefix text NOT NULL,
    key_hash bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    scopes text[] NOT NULL,
    allowed_ips cidr[] DEFAULT '{}'::cidr[] NOT NULL,
    expires_at timestamp with time zone,
    last_used_at timestamp with time zone,
    CONSTRAINT api_keys_name_check CHECK (((length(name) >= 1) AND (length(name) <= 100))),
    CONSTRAINT api_keys_scopes_check CHECK ((cardinality(scopes) > 0))
);

ALTER TABLE ONLY api_keys
    ADD CONSTRAINT api_keys_key_hash_key UNIQUE (key_hash);

ALTER TABLE ONLY api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);

CREATE INDEX api_keys_tenant_idx ON api_keys USING btree (tenant_id);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,DELETE ON TABLE api_keys TO ulka_app;

-- email_tokens
CREATE TABLE email_tokens (
    token_hash bytea NOT NULL,
    user_id uuid NOT NULL,
    purpose text NOT NULL,
    email text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT email_tokens_purpose_check CHECK ((purpose = ANY (ARRAY['verify_email'::text, 'reset_password'::text, 'change_email'::text])))
);

ALTER TABLE ONLY email_tokens
    ADD CONSTRAINT email_tokens_pkey PRIMARY KEY (token_hash);

CREATE INDEX email_tokens_user_idx ON email_tokens USING btree (user_id, purpose);

ALTER TABLE email_tokens ENABLE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,DELETE ON TABLE email_tokens TO ulka_app;

-- invites
CREATE TABLE invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid DEFAULT current_tenant() NOT NULL,
    email text NOT NULL,
    role text NOT NULL,
    token_hash bytea NOT NULL,
    invited_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT invites_email_check CHECK (((length(email) >= 3) AND (length(email) <= 254))),
    CONSTRAINT invites_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text, 'viewer'::text])))
);

ALTER TABLE ONLY invites
    ADD CONSTRAINT invites_pkey PRIMARY KEY (id);

ALTER TABLE ONLY invites
    ADD CONSTRAINT invites_token_hash_key UNIQUE (token_hash);

CREATE UNIQUE INDEX invites_tenant_email_key ON invites USING btree (tenant_id, lower(email));

ALTER TABLE invites ENABLE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,DELETE ON TABLE invites TO ulka_app;

GRANT UPDATE(role) ON TABLE invites TO ulka_app;

GRANT UPDATE(token_hash) ON TABLE invites TO ulka_app;

GRANT UPDATE(invited_by) ON TABLE invites TO ulka_app;

GRANT UPDATE(created_at) ON TABLE invites TO ulka_app;

GRANT UPDATE(expires_at) ON TABLE invites TO ulka_app;

-- login_failures
CREATE TABLE login_failures (
    email text NOT NULL,
    failures integer NOT NULL,
    window_start timestamp with time zone NOT NULL
);

ALTER TABLE ONLY login_failures
    ADD CONSTRAINT login_failures_pkey PRIMARY KEY (email);

ALTER TABLE login_failures ENABLE ROW LEVEL SECURITY;

-- support_visits
CREATE TABLE support_visits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid DEFAULT current_tenant() NOT NULL,
    user_id uuid NOT NULL,
    admin_id uuid NOT NULL,
    admin_name text NOT NULL,
    reason text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT support_visits_admin_name_check CHECK (((length(admin_name) >= 1) AND (length(admin_name) <= 100))),
    CONSTRAINT support_visits_reason_check CHECK (((length(reason) >= 1) AND (length(reason) <= 500)))
);

ALTER TABLE ONLY support_visits FORCE ROW LEVEL SECURITY;

ALTER TABLE ONLY support_visits
    ADD CONSTRAINT support_visits_pkey PRIMARY KEY (id);

CREATE INDEX support_visits_tenant_idx ON support_visits USING btree (tenant_id, started_at DESC);

CREATE INDEX support_visits_user_idx ON support_visits USING btree (user_id);

ALTER TABLE support_visits ENABLE ROW LEVEL SECURITY;

GRANT SELECT,INSERT ON TABLE support_visits TO ulka_app;

-- usage_records
CREATE TABLE usage_records (
    tenant_id uuid DEFAULT current_tenant() NOT NULL,
    meter text NOT NULL,
    key text NOT NULL,
    period timestamp with time zone NOT NULL,
    region text DEFAULT ''::text NOT NULL,
    quantity numeric NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT usage_records_meter_check CHECK ((meter = ANY (ARRAY['video_minutes_encoded'::text, 'video_minutes_stored'::text, 'video_delivery_bytes'::text, 'video_delivery_requests'::text]))),
    CONSTRAINT usage_records_period_check CHECK ((period = date_trunc('hour'::text, period))),
    CONSTRAINT usage_records_quantity_check CHECK ((quantity >= (0)::numeric))
);

ALTER TABLE ONLY usage_records
    ADD CONSTRAINT usage_records_pkey PRIMARY KEY (meter, key);

CREATE INDEX usage_records_tenant_period_idx ON usage_records USING btree (tenant_id, period);

ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,UPDATE ON TABLE usage_records TO ulka_app;

-- libraries
CREATE TABLE libraries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid DEFAULT current_tenant() NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    default_playback_policy text DEFAULT 'public'::text NOT NULL,
    mp4_downloads boolean DEFAULT false NOT NULL,
    allowed_domains text[] DEFAULT '{}'::text[] NOT NULL,
    player jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    preset_template text DEFAULT 'balanced'::text NOT NULL,
    preset_id uuid,
    inherits text[] DEFAULT '{player,transcoding,security}'::text[] NOT NULL,
    blocked_domains text[] DEFAULT '{}'::text[] NOT NULL,
    country_mode text DEFAULT 'allow'::text NOT NULL,
    countries text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT libraries_blocked_domains_check CHECK ((cardinality(blocked_domains) <= 50)),
    CONSTRAINT libraries_countries_check CHECK ((cardinality(countries) <= 250)),
    CONSTRAINT libraries_country_mode_check CHECK ((country_mode = ANY (ARRAY['allow'::text, 'deny'::text]))),
    CONSTRAINT libraries_default_playback_policy_check CHECK ((default_playback_policy = ANY (ARRAY['public'::text, 'signed'::text]))),
    CONSTRAINT libraries_description_check CHECK ((length(description) <= 500)),
    CONSTRAINT libraries_name_check CHECK (((length(name) >= 1) AND (length(name) <= 100))),
    CONSTRAINT libraries_one_website_list CHECK (((cardinality(allowed_domains) = 0) OR (cardinality(blocked_domains) = 0)))
);

ALTER TABLE ONLY libraries
    ADD CONSTRAINT libraries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY libraries
    ADD CONSTRAINT libraries_tenant_id_id_key UNIQUE (tenant_id, id);

CREATE UNIQUE INDEX libraries_name ON libraries USING btree (tenant_id, lower(name));

CREATE UNIQUE INDEX libraries_one_default ON libraries USING btree (tenant_id) WHERE is_default;

ALTER TABLE libraries ENABLE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE libraries TO ulka_app;

-- folders
CREATE TABLE folders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid DEFAULT current_tenant() NOT NULL,
    library_id uuid NOT NULL,
    parent_id uuid,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT folders_name_check CHECK (((length(name) >= 1) AND (length(name) <= 100)))
);

ALTER TABLE ONLY folders
    ADD CONSTRAINT folders_library_id_id_key UNIQUE (library_id, id);

ALTER TABLE ONLY folders
    ADD CONSTRAINT folders_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX folders_name ON folders USING btree (library_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

ALTER TABLE folders ENABLE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE folders TO ulka_app;

-- transcoding_presets
CREATE TABLE transcoding_presets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid DEFAULT current_tenant() NOT NULL,
    library_id uuid NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    heights integer[] NOT NULL,
    quality text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT transcoding_presets_description_check CHECK ((length(description) <= 200)),
    CONSTRAINT transcoding_presets_heights_check CHECK ((((cardinality(heights) >= 1) AND (cardinality(heights) <= 5)) AND (heights <@ ARRAY[240, 360, 480, 720, 1080]))),
    CONSTRAINT transcoding_presets_name_check CHECK (((length(name) >= 1) AND (length(name) <= 100))),
    CONSTRAINT transcoding_presets_quality_check CHECK ((quality = ANY (ARRAY['fast'::text, 'balanced'::text, 'high'::text])))
);

ALTER TABLE ONLY transcoding_presets
    ADD CONSTRAINT transcoding_presets_library_id_id_key UNIQUE (library_id, id);

ALTER TABLE ONLY transcoding_presets
    ADD CONSTRAINT transcoding_presets_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX transcoding_presets_name ON transcoding_presets USING btree (library_id, lower(name));

ALTER TABLE transcoding_presets ENABLE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE transcoding_presets TO ulka_app;

-- video_defaults
CREATE TABLE video_defaults (
    tenant_id uuid DEFAULT current_tenant() NOT NULL,
    player jsonb DEFAULT '{}'::jsonb NOT NULL,
    preset_template text DEFAULT 'balanced'::text NOT NULL,
    mp4_downloads boolean DEFAULT false NOT NULL,
    allowed_domains text[] DEFAULT '{}'::text[] NOT NULL,
    default_playback_policy text DEFAULT 'public'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    blocked_domains text[] DEFAULT '{}'::text[] NOT NULL,
    country_mode text DEFAULT 'allow'::text NOT NULL,
    countries text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT video_defaults_blocked_domains_check CHECK ((cardinality(blocked_domains) <= 50)),
    CONSTRAINT video_defaults_countries_check CHECK ((cardinality(countries) <= 250)),
    CONSTRAINT video_defaults_country_mode_check CHECK ((country_mode = ANY (ARRAY['allow'::text, 'deny'::text]))),
    CONSTRAINT video_defaults_default_playback_policy_check CHECK ((default_playback_policy = ANY (ARRAY['public'::text, 'signed'::text]))),
    CONSTRAINT video_defaults_one_website_list CHECK (((cardinality(allowed_domains) = 0) OR (cardinality(blocked_domains) = 0)))
);

ALTER TABLE ONLY video_defaults
    ADD CONSTRAINT video_defaults_pkey PRIMARY KEY (tenant_id);

ALTER TABLE video_defaults ENABLE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE video_defaults TO ulka_app;

-- assets
CREATE TABLE assets (
    id uuid NOT NULL,
    tenant_id uuid DEFAULT current_tenant() NOT NULL,
    upload_id uuid,
    status text NOT NULL,
    error_code text,
    passthrough text,
    source_key text NOT NULL,
    probe jsonb,
    duration_seconds double precision,
    width integer,
    height integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    plan jsonb,
    encryption_key bytea,
    encryption_iv bytea,
    source_deleted_at timestamp with time zone,
    input_url text,
    download text,
    captions jsonb DEFAULT '[]'::jsonb NOT NULL,
    library_id uuid NOT NULL,
    folder_id uuid,
    title text DEFAULT ''::text NOT NULL,
    deleted_at timestamp with time zone,
    description text DEFAULT ''::text NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    metadata jsonb DEFAULT '[]'::jsonb NOT NULL,
    chapters jsonb DEFAULT '[]'::jsonb NOT NULL,
    playback_policy text DEFAULT 'public'::text NOT NULL,
    poster_time double precision,
    poster_uploaded_at timestamp with time zone,
    timeline jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT assets_captions_check CHECK (((jsonb_typeof(captions) = 'array'::text) AND (jsonb_array_length(captions) <= 20))),
    CONSTRAINT assets_chapters_check CHECK (((jsonb_typeof(chapters) = 'array'::text) AND (jsonb_array_length(chapters) <= 100))),
    CONSTRAINT assets_description_check CHECK ((char_length(description) <= 2000)),
    CONSTRAINT assets_download_check CHECK ((download = ANY (ARRAY['preparing'::text, 'ready'::text, 'failed'::text]))),
    CONSTRAINT assets_input_url_check CHECK ((length(input_url) <= 2048)),
    CONSTRAINT assets_metadata_check CHECK (((jsonb_typeof(metadata) = 'array'::text) AND (jsonb_array_length(metadata) <= 20))),
    CONSTRAINT assets_one_cover CHECK (((poster_time IS NULL) OR (poster_uploaded_at IS NULL))),
    CONSTRAINT assets_passthrough_check CHECK ((length(passthrough) <= 255)),
    CONSTRAINT assets_playback_policy_check CHECK ((playback_policy = ANY (ARRAY['public'::text, 'signed'::text]))),
    CONSTRAINT assets_poster_time_check CHECK ((poster_time >= (0)::double precision)),
    CONSTRAINT assets_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'processing'::text, 'ready'::text, 'complete'::text, 'errored'::text]))),
    CONSTRAINT assets_tags_check CHECK ((cardinality(tags) <= 20)),
    CONSTRAINT assets_title_check CHECK ((length(title) <= 200))
);

ALTER TABLE ONLY assets
    ADD CONSTRAINT assets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY assets
    ADD CONSTRAINT assets_upload_id_key UNIQUE (upload_id);

CREATE INDEX assets_created_id_idx ON assets USING btree (created_at DESC, id DESC);

CREATE INDEX assets_library_idx ON assets USING btree (library_id, folder_id, created_at DESC, id DESC) WHERE (deleted_at IS NULL);

CREATE INDEX assets_metadata_idx ON assets USING gin (metadata jsonb_path_ops);

CREATE INDEX assets_source_due_idx ON assets USING btree (created_at) WHERE (source_deleted_at IS NULL);

CREATE INDEX assets_tags_idx ON assets USING gin (tags);

CREATE INDEX assets_tenant_created_idx ON assets USING btree (tenant_id, created_at DESC);

CREATE INDEX assets_trash_idx ON assets USING btree (library_id, deleted_at) WHERE (deleted_at IS NOT NULL);

ALTER TABLE assets ENABLE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE assets TO ulka_app;

-- uploads
CREATE TABLE uploads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid DEFAULT current_tenant() NOT NULL,
    asset_id uuid DEFAULT gen_random_uuid() NOT NULL,
    status text DEFAULT 'waiting'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '24:00:00'::interval) NOT NULL,
    store_id text,
    size bigint,
    CONSTRAINT uploads_size_check CHECK ((size > 0)),
    CONSTRAINT uploads_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'uploading'::text, 'complete'::text, 'expired'::text])))
);

ALTER TABLE ONLY uploads
    ADD CONSTRAINT uploads_asset_id_key UNIQUE (asset_id);

ALTER TABLE ONLY uploads
    ADD CONSTRAINT uploads_pkey PRIMARY KEY (id);

CREATE INDEX uploads_open_idx ON uploads USING btree (created_at) WHERE (status = ANY (ARRAY['waiting'::text, 'uploading'::text]));

CREATE INDEX uploads_tenant_idx ON uploads USING btree (tenant_id);

ALTER TABLE uploads ENABLE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,UPDATE ON TABLE uploads TO ulka_app;

-- upload_locks
CREATE TABLE upload_locks (
    upload_id text NOT NULL,
    holder text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    release_requested boolean DEFAULT false NOT NULL
);

ALTER TABLE ONLY upload_locks
    ADD CONSTRAINT upload_locks_pkey PRIMARY KEY (upload_id);

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE upload_locks TO ulka_app;

-- jobs
CREATE TABLE jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid DEFAULT current_tenant() NOT NULL,
    asset_id uuid NOT NULL,
    type text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT jobs_type_check CHECK ((type = ANY (ARRAY['ingest'::text, 'reencode'::text, 'av1_upgrade'::text, 'captions'::text, 'import'::text])))
);

ALTER TABLE ONLY jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);

CREATE INDEX jobs_asset_idx ON jobs USING btree (asset_id);

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,UPDATE ON TABLE jobs TO ulka_app;

-- signing_keys
CREATE TABLE signing_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid DEFAULT current_tenant() NOT NULL,
    secret bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY signing_keys
    ADD CONSTRAINT signing_keys_pkey PRIMARY KEY (id);

CREATE INDEX signing_keys_tenant_idx ON signing_keys USING btree (tenant_id, created_at DESC);

ALTER TABLE signing_keys ENABLE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,DELETE ON TABLE signing_keys TO ulka_app;

-- video_delivery
CREATE TABLE video_delivery (
    tenant_id uuid DEFAULT current_tenant() NOT NULL,
    mode text NOT NULL,
    custom_url text,
    cdn_distribution_id uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    provider text DEFAULT 'other'::text NOT NULL,
    CONSTRAINT video_delivery_custom_url_check CHECK ((length(custom_url) <= 300)),
    CONSTRAINT video_delivery_mode_check CHECK ((mode = ANY (ARRAY['origin'::text, 'ulka_cdn'::text, 'custom'::text]))),
    CONSTRAINT video_delivery_provider_check CHECK ((provider = ANY (ARRAY['ulka'::text, 'cloudflare'::text, 'cloudfront'::text, 'bunny'::text, 'fastly'::text, 'akamai'::text, 'other'::text])))
);

ALTER TABLE ONLY video_delivery
    ADD CONSTRAINT video_delivery_pkey PRIMARY KEY (tenant_id);

CREATE INDEX video_delivery_cdn_distribution_idx ON video_delivery USING btree (cdn_distribution_id);

ALTER TABLE video_delivery ENABLE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,UPDATE ON TABLE video_delivery TO ulka_app;

-- playback_reports
CREATE TABLE playback_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid DEFAULT current_tenant() NOT NULL,
    asset_id uuid NOT NULL,
    code text NOT NULL,
    ip text NOT NULL,
    country text DEFAULT ''::text NOT NULL,
    user_agent text DEFAULT ''::text NOT NULL,
    plays boolean NOT NULL,
    results jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT playback_reports_code_check CHECK ((code ~ '^UL-[0-9A-Z]{6}$'::text)),
    CONSTRAINT playback_reports_user_agent_check CHECK ((length(user_agent) <= 512))
);

ALTER TABLE ONLY playback_reports
    ADD CONSTRAINT playback_reports_code_key UNIQUE (code);

ALTER TABLE ONLY playback_reports
    ADD CONSTRAINT playback_reports_pkey PRIMARY KEY (id);

CREATE INDEX playback_reports_asset_idx ON playback_reports USING btree (asset_id, created_at DESC, id);

CREATE INDEX playback_reports_created_idx ON playback_reports USING btree (created_at);

CREATE INDEX playback_reports_tenant_idx ON playback_reports USING btree (tenant_id);

ALTER TABLE playback_reports ENABLE ROW LEVEL SECURITY;

GRANT SELECT,INSERT ON TABLE playback_reports TO ulka_app;

-- encode_tasks
CREATE TABLE encode_tasks (
    tenant_id uuid DEFAULT current_tenant() NOT NULL,
    asset_id uuid NOT NULL,
    lane text NOT NULL,
    chunk integer NOT NULL,
    done boolean DEFAULT false NOT NULL,
    job_id uuid,
    node_id text,
    leased_until timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    failed_at timestamp with time zone,
    progress real DEFAULT 0 NOT NULL,
    done_at timestamp with time zone,
    CONSTRAINT encode_tasks_lane_check CHECK ((lane = ANY (ARRAY['fast'::text, 'full'::text, 'audio'::text]))),
    CONSTRAINT encode_tasks_progress_check CHECK (((progress >= (0)::double precision) AND (progress <= (1)::double precision)))
);

ALTER TABLE ONLY encode_tasks
    ADD CONSTRAINT encode_tasks_pkey PRIMARY KEY (asset_id, lane, chunk);

CREATE INDEX encode_tasks_waiting ON encode_tasks USING btree (created_at) WHERE ((NOT done) AND (failed_at IS NULL));

ALTER TABLE encode_tasks ENABLE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE encode_tasks TO ulka_app;

-- webhook_endpoints
CREATE TABLE webhook_endpoints (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid DEFAULT current_tenant() NOT NULL,
    url text NOT NULL,
    secret bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    events text[] DEFAULT '{}'::text[] NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    CONSTRAINT webhook_endpoints_events_check CHECK ((cardinality(events) <= 50)),
    CONSTRAINT webhook_endpoints_name_check CHECK ((char_length(name) <= 100)),
    CONSTRAINT webhook_endpoints_url_check CHECK (((url ~~ 'https://%'::text) AND (length(url) <= 2048)))
);

ALTER TABLE ONLY webhook_endpoints
    ADD CONSTRAINT webhook_endpoints_pkey PRIMARY KEY (id);

CREATE INDEX webhook_endpoints_tenant_idx ON webhook_endpoints USING btree (tenant_id);

ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,DELETE ON TABLE webhook_endpoints TO ulka_app;

GRANT UPDATE(url) ON TABLE webhook_endpoints TO ulka_app;

GRANT UPDATE(name) ON TABLE webhook_endpoints TO ulka_app;

GRANT UPDATE(events) ON TABLE webhook_endpoints TO ulka_app;

GRANT UPDATE(enabled) ON TABLE webhook_endpoints TO ulka_app;

-- webhook_deliveries
CREATE TABLE webhook_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid DEFAULT current_tenant() NOT NULL,
    endpoint_id uuid NOT NULL,
    event text NOT NULL,
    body jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    status_code integer,
    attempts integer DEFAULT 0 NOT NULL,
    failure text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    attempted_at timestamp with time zone,
    next_attempt_at timestamp with time zone,
    CONSTRAINT webhook_deliveries_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'retrying'::text, 'done'::text, 'failed'::text])))
);

ALTER TABLE ONLY webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (id);

CREATE INDEX webhook_deliveries_created_idx ON webhook_deliveries USING btree (created_at);

CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries USING btree (endpoint_id, created_at DESC, id DESC);

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;

GRANT SELECT,INSERT,UPDATE ON TABLE webhook_deliveries TO ulka_app;

-- Foreign keys, after every table exists.
ALTER TABLE ONLY tenant_members
    ADD CONSTRAINT tenant_members_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY tenant_members
    ADD CONSTRAINT tenant_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY api_keys
    ADD CONSTRAINT api_keys_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY email_tokens
    ADD CONSTRAINT email_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY invites
    ADD CONSTRAINT invites_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE ONLY invites
    ADD CONSTRAINT invites_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY support_visits
    ADD CONSTRAINT support_visits_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY support_visits
    ADD CONSTRAINT support_visits_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY usage_records
    ADD CONSTRAINT usage_records_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY libraries
    ADD CONSTRAINT libraries_id_preset_id_fkey FOREIGN KEY (id, preset_id) REFERENCES transcoding_presets(library_id, id) ON DELETE SET NULL (preset_id);

ALTER TABLE ONLY libraries
    ADD CONSTRAINT libraries_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY folders
    ADD CONSTRAINT folders_library_id_parent_id_fkey FOREIGN KEY (library_id, parent_id) REFERENCES folders(library_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY folders
    ADD CONSTRAINT folders_tenant_id_library_id_fkey FOREIGN KEY (tenant_id, library_id) REFERENCES libraries(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY transcoding_presets
    ADD CONSTRAINT transcoding_presets_tenant_id_library_id_fkey FOREIGN KEY (tenant_id, library_id) REFERENCES libraries(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY video_defaults
    ADD CONSTRAINT video_defaults_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY assets
    ADD CONSTRAINT assets_library_id_folder_id_fkey FOREIGN KEY (library_id, folder_id) REFERENCES folders(library_id, id) ON DELETE SET NULL (folder_id);

ALTER TABLE ONLY assets
    ADD CONSTRAINT assets_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY assets
    ADD CONSTRAINT assets_tenant_id_library_id_fkey FOREIGN KEY (tenant_id, library_id) REFERENCES libraries(tenant_id, id);

ALTER TABLE ONLY assets
    ADD CONSTRAINT assets_upload_id_fkey FOREIGN KEY (upload_id) REFERENCES uploads(id);

ALTER TABLE ONLY uploads
    ADD CONSTRAINT uploads_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY jobs
    ADD CONSTRAINT jobs_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE;

ALTER TABLE ONLY jobs
    ADD CONSTRAINT jobs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY signing_keys
    ADD CONSTRAINT signing_keys_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY video_delivery
    ADD CONSTRAINT video_delivery_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY playback_reports
    ADD CONSTRAINT playback_reports_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE;

ALTER TABLE ONLY playback_reports
    ADD CONSTRAINT playback_reports_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY encode_tasks
    ADD CONSTRAINT encode_tasks_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE;

ALTER TABLE ONLY encode_tasks
    ADD CONSTRAINT encode_tasks_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY webhook_endpoints
    ADD CONSTRAINT webhook_endpoints_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_endpoint_id_fkey FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints(id) ON DELETE CASCADE;

ALTER TABLE ONLY webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

-- Row-level security policies.
CREATE POLICY member_tenants ON tenants FOR SELECT USING ((id IN ( SELECT tenant_members.tenant_id
   FROM tenant_members
  WHERE (tenant_members.user_id = current_app_user()))));

CREATE POLICY tenant_isolation ON tenants USING ((id = current_tenant()));

CREATE POLICY members_read ON users FOR SELECT USING ((id IN ( SELECT tenant_members.user_id
   FROM tenant_members
  WHERE (tenant_members.tenant_id = current_tenant()))));

CREATE POLICY self ON users USING ((id = current_app_user()));

CREATE POLICY own_memberships ON tenant_members FOR SELECT USING ((user_id = current_app_user()));

CREATE POLICY tenant_isolation ON tenant_members USING ((tenant_id = current_tenant()));

CREATE POLICY own_sessions ON sessions USING ((user_id = current_app_user()));

CREATE POLICY tenant_isolation ON sessions USING ((tenant_id = current_tenant()));

CREATE POLICY tenant_isolation ON api_keys USING ((tenant_id = current_tenant()));

CREATE POLICY self ON email_tokens USING ((user_id = current_app_user()));

CREATE POLICY tenant_isolation ON invites USING ((tenant_id = current_tenant()));

CREATE POLICY tenant_isolation ON support_visits USING ((tenant_id = current_tenant()));

CREATE POLICY tenant_isolation ON usage_records USING ((tenant_id = current_tenant()));

CREATE POLICY tenant_isolation ON libraries USING ((tenant_id = current_tenant()));

CREATE POLICY tenant_isolation ON folders USING ((tenant_id = current_tenant()));

CREATE POLICY tenant_isolation ON transcoding_presets USING ((tenant_id = current_tenant()));

CREATE POLICY tenant_isolation ON video_defaults USING ((tenant_id = current_tenant()));

CREATE POLICY tenant_isolation ON assets USING ((tenant_id = current_tenant()));

CREATE POLICY tenant_isolation ON uploads USING ((tenant_id = current_tenant()));

CREATE POLICY tenant_isolation ON jobs USING ((tenant_id = current_tenant()));

CREATE POLICY tenant_isolation ON signing_keys USING ((tenant_id = current_tenant()));

CREATE POLICY tenant_isolation ON video_delivery USING ((tenant_id = current_tenant()));

CREATE POLICY tenant_isolation ON playback_reports USING ((tenant_id = current_tenant()));

CREATE POLICY tenant_isolation ON encode_tasks USING ((tenant_id = current_tenant()));

CREATE POLICY tenant_isolation ON webhook_endpoints USING ((tenant_id = current_tenant()));

CREATE POLICY tenant_isolation ON webhook_deliveries USING ((tenant_id = current_tenant()));

-- Functions: narrow, SECURITY DEFINER where a lookup must cross tenants (sign-in, playback, the scheduler).
CREATE FUNCTION acting_handoff(p_old bytea, p_new bytea) RETURNS timestamp with time zone
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    UPDATE sessions SET token_hash = p_new
    WHERE token_hash = p_old AND acting_admin_id IS NOT NULL AND created_at > now() - interval '2 minutes' AND expires_at > now()
    RETURNING expires_at
$$;

REVOKE ALL ON FUNCTION acting_handoff(p_old bytea, p_new bytea) FROM PUBLIC;
GRANT ALL ON FUNCTION acting_handoff(p_old bytea, p_new bytea) TO ulka_app;

CREATE FUNCTION api_key_lookup(p_key_hash bytea) RETURNS TABLE(id uuid, tenant_id uuid, scopes text[], allowed_ips cidr[])
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT k.id, k.tenant_id, k.scopes, k.allowed_ips FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
    WHERE k.key_hash = p_key_hash AND (k.expires_at IS NULL OR k.expires_at > now()) AND t.suspended_at IS NULL
$$;

REVOKE ALL ON FUNCTION api_key_lookup(p_key_hash bytea) FROM PUBLIC;
GRANT ALL ON FUNCTION api_key_lookup(p_key_hash bytea) TO ulka_app;

CREATE FUNCTION api_key_used(p_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    UPDATE api_keys SET last_used_at = now()
    WHERE id = p_id AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')
$$;

REVOKE ALL ON FUNCTION api_key_used(p_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION api_key_used(p_id uuid) TO ulka_app;

CREATE FUNCTION create_invited_user(p_email text, p_password_hash text, p_name text) RETURNS uuid
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    INSERT INTO users (email, password_hash, name, email_verified_at) VALUES (p_email, p_password_hash, nullif(p_name, ''), now())
    RETURNING id
$$;

REVOKE ALL ON FUNCTION create_invited_user(p_email text, p_password_hash text, p_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION create_invited_user(p_email text, p_password_hash text, p_name text) TO ulka_app;

CREATE FUNCTION email_token_lookup(p_token_hash bytea, p_purpose text) RETURNS TABLE(user_id uuid, email text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT user_id, email FROM email_tokens WHERE token_hash = p_token_hash AND purpose = p_purpose AND expires_at > now()
$$;

REVOKE ALL ON FUNCTION email_token_lookup(p_token_hash bytea, p_purpose text) FROM PUBLIC;
GRANT ALL ON FUNCTION email_token_lookup(p_token_hash bytea, p_purpose text) TO ulka_app;

CREATE FUNCTION expired_uploads(p_limit integer) RETURNS TABLE(tenant_id uuid, upload_id uuid, asset_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT tenant_id, id, asset_id FROM uploads
    WHERE (status = 'waiting' AND expires_at < now())
       OR (status = 'uploading' AND created_at < now() - interval '7 days')
    ORDER BY created_at LIMIT p_limit
$$;

REVOKE ALL ON FUNCTION expired_uploads(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION expired_uploads(p_limit integer) TO ulka_app;

CREATE FUNCTION invite_lookup(p_token_hash bytea) RETURNS TABLE(id uuid, tenant_id uuid, tenant_name text, email text, role text, account_exists boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT i.id, i.tenant_id, t.name, i.email, i.role, exists(SELECT 1 FROM users u WHERE lower(u.email) = lower(i.email))
    FROM invites i JOIN tenants t ON t.id = i.tenant_id
    WHERE i.token_hash = p_token_hash AND i.expires_at > now() AND t.suspended_at IS NULL
$$;

REVOKE ALL ON FUNCTION invite_lookup(p_token_hash bytea) FROM PUBLIC;
GRANT ALL ON FUNCTION invite_lookup(p_token_hash bytea) TO ulka_app;

CREATE FUNCTION login_blocked(p_email text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT exists(SELECT 1 FROM login_failures
        WHERE email = lower(p_email) AND failures >= 10 AND window_start > now() - interval '15 minutes')
$$;

REVOKE ALL ON FUNCTION login_blocked(p_email text) FROM PUBLIC;
GRANT ALL ON FUNCTION login_blocked(p_email text) TO ulka_app;

CREATE FUNCTION login_failed(p_email text) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    INSERT INTO login_failures (email, failures, window_start) VALUES (lower(p_email), 1, now())
    ON CONFLICT (email) DO UPDATE SET
        failures     = CASE WHEN login_failures.window_start > now() - interval '15 minutes' THEN login_failures.failures + 1 ELSE 1 END,
        window_start = CASE WHEN login_failures.window_start > now() - interval '15 minutes' THEN login_failures.window_start ELSE now() END
$$;

REVOKE ALL ON FUNCTION login_failed(p_email text) FROM PUBLIC;
GRANT ALL ON FUNCTION login_failed(p_email text) TO ulka_app;

CREATE FUNCTION login_lookup(p_email text) RETURNS TABLE(user_id uuid, password_hash text, tenant_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT u.id, u.password_hash,
        (SELECT m.tenant_id FROM tenant_members m JOIN tenants t ON t.id = m.tenant_id
         WHERE m.user_id = u.id AND t.suspended_at IS NULL ORDER BY m.created_at LIMIT 1)
    FROM users u WHERE lower(u.email) = lower(p_email) AND u.disabled_at IS NULL
$$;

REVOKE ALL ON FUNCTION login_lookup(p_email text) FROM PUBLIC;
GRANT ALL ON FUNCTION login_lookup(p_email text) TO ulka_app;

CREATE FUNCTION login_succeeded(p_email text) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    DELETE FROM login_failures WHERE email = lower(p_email)
$$;

REVOKE ALL ON FUNCTION login_succeeded(p_email text) FROM PUBLIC;
GRANT ALL ON FUNCTION login_succeeded(p_email text) TO ulka_app;

CREATE FUNCTION playback_reports_expire() RETURNS bigint
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$ WITH gone AS (DELETE FROM playback_reports WHERE created_at < now() - interval '30 days' RETURNING 1)
          SELECT count(*) FROM gone $$;

REVOKE ALL ON FUNCTION playback_reports_expire() FROM PUBLIC;
GRANT ALL ON FUNCTION playback_reports_expire() TO ulka_app;

CREATE FUNCTION retention_core() RETURNS TABLE(tbl text, deleted bigint)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    WITH s AS (DELETE FROM sessions WHERE expires_at < now() RETURNING 1),
         e AS (DELETE FROM email_tokens WHERE expires_at < now() RETURNING 1),
         i AS (DELETE FROM invites WHERE expires_at < now() - interval '7 days' RETURNING 1),
         l AS (DELETE FROM login_failures WHERE window_start < now() - interval '1 day' RETURNING 1),
         u AS (DELETE FROM usage_records WHERE period < now() - interval '400 days' RETURNING 1),
         v AS (DELETE FROM support_visits WHERE started_at < now() - interval '2 years' RETURNING 1)
    SELECT 'sessions', count(*) FROM s UNION ALL SELECT 'email_tokens', count(*) FROM e
    UNION ALL SELECT 'invites', count(*) FROM i UNION ALL SELECT 'login_failures', count(*) FROM l
    UNION ALL SELECT 'usage_records', count(*) FROM u UNION ALL SELECT 'support_visits', count(*) FROM v
$$;

REVOKE ALL ON FUNCTION retention_core() FROM PUBLIC;
GRANT ALL ON FUNCTION retention_core() TO ulka_app;

CREATE FUNCTION retention_webhooks() RETURNS bigint
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    WITH d AS (DELETE FROM webhook_deliveries WHERE created_at < now() - interval '30 days' RETURNING 1) SELECT count(*) FROM d
$$;

REVOKE ALL ON FUNCTION retention_webhooks() FROM PUBLIC;
GRANT ALL ON FUNCTION retention_webhooks() TO ulka_app;

CREATE FUNCTION scheduler_claim(p_node text, p_free integer, p_tenant_cap integer, p_lease interval, p_max integer) RETURNS TABLE(tenant_id uuid, asset_id uuid, job_id uuid, lane text, chunk integer, attempts integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
#variable_conflict use_column
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('scheduler_claim'));
    RETURN QUERY
    WITH running AS (
        SELECT t.tenant_id, count(*) AS n FROM encode_tasks t WHERE NOT t.done AND t.leased_until > now() GROUP BY t.tenant_id
    ), waiting AS (
        SELECT t.tenant_id, t.asset_id, t.lane, t.chunk, t.created_at,
               CASE t.lane WHEN 'fast' THEN 0 WHEN 'audio' THEN 1 ELSE 2 END AS lane_rank,
               row_number() OVER (PARTITION BY t.tenant_id ORDER BY CASE t.lane WHEN 'fast' THEN 0 WHEN 'audio' THEN 1 ELSE 2 END, t.created_at, t.chunk) AS place
        FROM encode_tasks t
        WHERE NOT t.done AND t.failed_at IS NULL AND (t.leased_until IS NULL OR t.leased_until <= now()) AND t.attempts < p_max
    ), picked AS (
        SELECT w.* FROM waiting w LEFT JOIN running r ON r.tenant_id = w.tenant_id
        WHERE w.place + coalesce(r.n, 0) <= p_tenant_cap
        ORDER BY w.place + coalesce(r.n, 0), w.lane_rank, w.created_at
        LIMIT p_free
    )
    UPDATE encode_tasks e SET node_id = p_node, leased_until = now() + p_lease, attempts = e.attempts + 1, started_at = now()
    FROM picked WHERE e.asset_id = picked.asset_id AND e.lane = picked.lane AND e.chunk = picked.chunk
    RETURNING e.tenant_id, e.asset_id, e.job_id, e.lane, e.chunk, e.attempts;
END $$;

REVOKE ALL ON FUNCTION scheduler_claim(p_node text, p_free integer, p_tenant_cap integer, p_lease interval, p_max integer) FROM PUBLIC;
GRANT ALL ON FUNCTION scheduler_claim(p_node text, p_free integer, p_tenant_cap integer, p_lease interval, p_max integer) TO ulka_app;

CREATE FUNCTION scheduler_exhausted(p_max integer) RETURNS TABLE(tenant_id uuid, asset_id uuid, job_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT DISTINCT ON (t.asset_id) t.tenant_id, t.asset_id, t.job_id FROM encode_tasks t
    WHERE NOT t.done AND t.failed_at IS NULL AND t.attempts >= p_max AND (t.leased_until IS NULL OR t.leased_until <= now())
$$;

REVOKE ALL ON FUNCTION scheduler_exhausted(p_max integer) FROM PUBLIC;
GRANT ALL ON FUNCTION scheduler_exhausted(p_max integer) TO ulka_app;

CREATE FUNCTION scheduler_progress(p_asset uuid, p_lane text, p_chunk integer, p_node text, p_progress real) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    UPDATE encode_tasks SET progress = least(greatest(p_progress, 0), 1)
    WHERE asset_id = p_asset AND lane = p_lane AND chunk = p_chunk AND node_id = p_node AND NOT done
$$;

REVOKE ALL ON FUNCTION scheduler_progress(p_asset uuid, p_lane text, p_chunk integer, p_node text, p_progress real) FROM PUBLIC;
GRANT ALL ON FUNCTION scheduler_progress(p_asset uuid, p_lane text, p_chunk integer, p_node text, p_progress real) TO ulka_app;

CREATE FUNCTION scheduler_release(p_asset uuid, p_lane text, p_chunk integer, p_node text, p_error text, p_retry interval) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    UPDATE encode_tasks SET node_id = NULL, leased_until = now() + p_retry, last_error = left(p_error, 500)
    WHERE asset_id = p_asset AND lane = p_lane AND chunk = p_chunk AND node_id = p_node AND NOT done
$$;

REVOKE ALL ON FUNCTION scheduler_release(p_asset uuid, p_lane text, p_chunk integer, p_node text, p_error text, p_retry interval) FROM PUBLIC;
GRANT ALL ON FUNCTION scheduler_release(p_asset uuid, p_lane text, p_chunk integer, p_node text, p_error text, p_retry interval) TO ulka_app;

CREATE FUNCTION scheduler_renew(p_node text, p_lease interval) RETURNS integer
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    WITH u AS (UPDATE encode_tasks SET leased_until = now() + p_lease
               WHERE node_id = p_node AND NOT done AND leased_until > now() RETURNING 1)
    SELECT count(*)::int FROM u
$$;

REVOKE ALL ON FUNCTION scheduler_renew(p_node text, p_lease interval) FROM PUBLIC;
GRANT ALL ON FUNCTION scheduler_renew(p_node text, p_lease interval) TO ulka_app;

CREATE FUNCTION scheduler_written_off(p_asset uuid, p_max integer) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    UPDATE encode_tasks SET failed_at = now() WHERE asset_id = p_asset AND NOT done AND failed_at IS NULL AND attempts >= p_max
$$;

REVOKE ALL ON FUNCTION scheduler_written_off(p_asset uuid, p_max integer) FROM PUBLIC;
GRANT ALL ON FUNCTION scheduler_written_off(p_asset uuid, p_max integer) TO ulka_app;

CREATE FUNCTION session_lookup(p_token_hash bytea) RETURNS TABLE(user_id uuid, tenant_id uuid, role text, acting_admin_id uuid, acting_admin_name text, expires_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT s.user_id, s.tenant_id, m.role, s.acting_admin_id, s.acting_admin_name, s.expires_at FROM sessions s
    JOIN tenants t ON t.id = s.tenant_id
    JOIN users u ON u.id = s.user_id
    JOIN tenant_members m ON m.tenant_id = s.tenant_id AND m.user_id = s.user_id
    WHERE s.token_hash = p_token_hash AND s.expires_at > now() AND t.suspended_at IS NULL AND u.disabled_at IS NULL
$$;

REVOKE ALL ON FUNCTION session_lookup(p_token_hash bytea) FROM PUBLIC;
GRANT ALL ON FUNCTION session_lookup(p_token_hash bytea) TO ulka_app;

CREATE FUNCTION session_seen(p_token_hash bytea) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    UPDATE sessions SET last_seen_at = now() WHERE token_hash = p_token_hash AND last_seen_at < now() - interval '5 minutes'
$$;

REVOKE ALL ON FUNCTION session_seen(p_token_hash bytea) FROM PUBLIC;
GRANT ALL ON FUNCTION session_seen(p_token_hash bytea) TO ulka_app;

CREATE FUNCTION signup(p_email text, p_password_hash text, p_tenant_name text, p_name text) RETURNS TABLE(tenant_id uuid, user_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    tenant_id := gen_random_uuid();
    INSERT INTO tenants (id, name) VALUES (tenant_id, p_tenant_name);
    INSERT INTO users (email, password_hash, name) VALUES (p_email, p_password_hash, nullif(p_name, '')) RETURNING id INTO user_id;
    INSERT INTO tenant_members (tenant_id, user_id, role) VALUES (signup.tenant_id, signup.user_id, 'owner');
    RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION signup(p_email text, p_password_hash text, p_tenant_name text, p_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION signup(p_email text, p_password_hash text, p_tenant_name text, p_name text) TO ulka_app;

CREATE FUNCTION sources_due_for_deletion(p_limit integer) RETURNS TABLE(tenant_id uuid, asset_id uuid, source_key text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT tenant_id, id, source_key FROM assets
    WHERE source_deleted_at IS NULL AND created_at < now() - interval '30 days'
    ORDER BY created_at LIMIT p_limit
$$;

REVOKE ALL ON FUNCTION sources_due_for_deletion(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION sources_due_for_deletion(p_limit integer) TO ulka_app;

CREATE FUNCTION stored_minutes() RETURNS TABLE(tenant_id uuid, minutes double precision)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT tenant_id, sum(duration_seconds) / 60 FROM assets
    WHERE status IN ('ready', 'complete') AND duration_seconds IS NOT NULL GROUP BY tenant_id
$$;

REVOKE ALL ON FUNCTION stored_minutes() FROM PUBLIC;
GRANT ALL ON FUNCTION stored_minutes() TO ulka_app;

CREATE FUNCTION trashed_due_for_purge(p_days integer) RETURNS TABLE(tenant_id uuid, asset_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT tenant_id, id FROM assets WHERE deleted_at < now() - make_interval(days => p_days) ORDER BY deleted_at LIMIT 200
$$;

REVOKE ALL ON FUNCTION trashed_due_for_purge(p_days integer) FROM PUBLIC;
GRANT ALL ON FUNCTION trashed_due_for_purge(p_days integer) TO ulka_app;

CREATE FUNCTION upload_begin(p_id uuid, p_store_id text, p_size bigint) RETURNS TABLE(tenant_id uuid, asset_id uuid)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    UPDATE uploads SET status = 'uploading', store_id = p_store_id, size = p_size
    WHERE id = p_id AND status IN ('waiting', 'uploading') AND expires_at > now()
    RETURNING tenant_id, asset_id
$$;

REVOKE ALL ON FUNCTION upload_begin(p_id uuid, p_store_id text, p_size bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION upload_begin(p_id uuid, p_store_id text, p_size bigint) TO ulka_app;

CREATE FUNCTION upload_state(p_id uuid) RETURNS TABLE(tenant_id uuid, asset_id uuid, status text, store_id text, size bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT tenant_id, asset_id, status, store_id, size FROM uploads
    WHERE id = p_id AND status IN ('waiting', 'uploading', 'complete') AND expires_at > now()
$$;

REVOKE ALL ON FUNCTION upload_state(p_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION upload_state(p_id uuid) TO ulka_app;

CREATE FUNCTION user_id_by_email(p_email text) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT id FROM users WHERE lower(email) = lower(p_email)
$$;

REVOKE ALL ON FUNCTION user_id_by_email(p_email text) FROM PUBLIC;
GRANT ALL ON FUNCTION user_id_by_email(p_email text) TO ulka_app;

CREATE FUNCTION user_signed_in(p_user uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    UPDATE users SET last_login_at = now() WHERE id = p_user
$$;

REVOKE ALL ON FUNCTION user_signed_in(p_user uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION user_signed_in(p_user uuid) TO ulka_app;

CREATE FUNCTION video_lookup(p_library uuid, p_video uuid) RETURNS TABLE(tenant_id uuid, policy text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT a.tenant_id, a.playback_policy FROM assets a JOIN tenants t ON t.id = a.tenant_id
    WHERE a.id = p_video AND a.library_id = p_library AND a.deleted_at IS NULL AND t.suspended_at IS NULL
$$;

SET default_tablespace = '';

SET default_table_access_method = heap;

REVOKE ALL ON FUNCTION video_lookup(p_library uuid, p_video uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION video_lookup(p_library uuid, p_video uuid) TO ulka_app;
