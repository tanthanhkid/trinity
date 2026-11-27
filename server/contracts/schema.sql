CREATE SCHEMA platform;

CREATE SCHEMA public;

COMMENT ON SCHEMA public IS 'standard public schema';

CREATE TYPE public."NewsfeedMediaType" AS ENUM (
    'image',
    'video'
);

CREATE FUNCTION public.trinity_code_num(p_seq bigint) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE WHEN p_seq < 1000 THEN lpad(p_seq::text, 3, '0') ELSE p_seq::text END
$$;

CREATE FUNCTION public.trinity_code_prefix_taken(p_prefix text, p_self_id integer) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT p_prefix = ANY(trinity_reserved_code_prefixes())
      OR EXISTS (SELECT 1 FROM custom_objects o WHERE o.id IS DISTINCT FROM p_self_id
                 AND (o.code_prefix = p_prefix OR p_prefix = ANY(o.code_prefix_aliases)))
$$;

CREATE FUNCTION public.trinity_core_code() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.code IS NULL THEN
    NEW.code := TG_ARGV[0] || trinity_code_num(nextval(TG_ARGV[1]::regclass));
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.trinity_custom_objects_code_prefix() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.code_prefix IS NULL OR NEW.code_prefix = '' THEN
    PERFORM pg_advisory_xact_lock(7374);
    NEW.code_prefix := trinity_pick_code_prefix(NEW.label, NEW.id);
  ELSE
    NEW.code_prefix := upper(NEW.code_prefix);
  END IF;
  IF NEW.next_code_seq IS NULL THEN NEW.next_code_seq := 1; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.trinity_custom_records_code() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE p TEXT; s INTEGER;
BEGIN
  IF NEW.code IS NOT NULL THEN RETURN NEW; END IF;
  UPDATE custom_objects SET next_code_seq = COALESCE(next_code_seq, 1) + 1
  WHERE id = NEW.object_id RETURNING code_prefix, next_code_seq - 1 INTO p, s;
  IF p IS NULL THEN RETURN NEW; END IF;
  NEW.code_seq := s;
  NEW.code := p || trinity_code_num(s);
  RETURN NEW;
END $$;

CREATE FUNCTION public.trinity_pick_code_prefix(p_label text, p_self_id integer) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  s TEXT; words TEXT[]; n INT; base TEXT := ''; ext TEXT; cand TEXT; i INT; c1 INT; c2 INT;
BEGIN
  s := translate(normalize(lower(coalesce(p_label, '')), NFC),
    'àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ',
    'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd');
  s := regexp_replace(s, '[^a-z]+', ' ', 'g');
  words := array_remove(regexp_split_to_array(btrim(s), '\s+'), '');
  n := coalesce(array_length(words, 1), 0);
  IF n = 0 THEN words := ARRAY['bang']; n := 1; END IF;
  IF n = 1 THEN
    base := left(words[1] || 'x', 2);
    ext := substr(words[1], 3);
  ELSE
    FOR i IN 1..least(n, 4) LOOP base := base || left(words[i], 1); END LOOP;
    ext := substr(words[least(n, 4)], 2);
  END IF;
  base := upper(base);
  ext := upper(ext);
  IF NOT trinity_code_prefix_taken(base, p_self_id) THEN RETURN base; END IF;
  cand := base;
  FOR i IN 1..length(ext) LOOP
    EXIT WHEN length(cand) >= 4;
    cand := cand || substr(ext, i, 1);
    IF NOT trinity_code_prefix_taken(cand, p_self_id) THEN RETURN cand; END IF;
  END LOOP;
  FOR c1 IN 65..90 LOOP
    cand := left(base, 3) || chr(c1);
    IF NOT trinity_code_prefix_taken(cand, p_self_id) THEN RETURN cand; END IF;
  END LOOP;
  FOR c1 IN 65..90 LOOP
    FOR c2 IN 65..90 LOOP
      cand := left(base, 2) || chr(c1) || chr(c2);
      IF NOT trinity_code_prefix_taken(cand, p_self_id) THEN RETURN cand; END IF;
    END LOOP;
  END LOOP;
  RAISE EXCEPTION 'Không sinh được tiền tố mã cho bảng "%"', p_label;
END $$;

CREATE FUNCTION public.trinity_platform_sync_facebook_page() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      BEGIN
        IF TG_OP IN ('UPDATE', 'DELETE') THEN
          DELETE FROM platform.company_routes WHERE kind = 'facebook_page' AND external_id = OLD."page_id" AND company_id = 1;
        END IF;
        IF TG_OP IN ('INSERT', 'UPDATE') THEN
          INSERT INTO platform.company_routes (kind, external_id, company_id) VALUES ('facebook_page', NEW."page_id", 1)
          ON CONFLICT (kind, external_id) DO NOTHING;
          IF NOT EXISTS (SELECT 1 FROM platform.company_routes
                         WHERE kind = 'facebook_page' AND external_id = NEW."page_id" AND company_id = 1) THEN
            RAISE EXCEPTION 'TRINITY_ROUTE_TAKEN: facebook_page % is connected to another company', NEW."page_id";
          END IF;
        END IF;
        RETURN NULL;
      END $$;

CREATE FUNCTION public.trinity_platform_sync_login() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP IN ('UPDATE', 'DELETE') THEN
        DELETE FROM platform.company_logins WHERE email = lower(OLD.email) AND company_id = 1;
      END IF;
      IF TG_OP IN ('INSERT', 'UPDATE') THEN
        INSERT INTO platform.company_logins (email, company_id) VALUES (lower(NEW.email), 1)
        ON CONFLICT (email) DO UPDATE SET company_id = EXCLUDED.company_id
          WHERE platform.company_logins.company_id = 1;
        IF NOT EXISTS (SELECT 1 FROM platform.company_logins WHERE email = lower(NEW.email) AND company_id = 1) THEN
          RAISE EXCEPTION 'TRINITY_EMAIL_TAKEN: % already belongs to another company', NEW.email;
        END IF;
      END IF;
      RETURN NULL;
    END $$;

COMMENT ON FUNCTION public.trinity_platform_sync_login() IS 'trinity-sync-v3';

CREATE FUNCTION public.trinity_platform_sync_zalo_oa() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
      BEGIN
        IF TG_OP IN ('UPDATE', 'DELETE') THEN
          DELETE FROM platform.company_routes WHERE kind = 'zalo_oa' AND external_id = OLD."oa_id" AND company_id = 1;
        END IF;
        IF TG_OP IN ('INSERT', 'UPDATE') THEN
          INSERT INTO platform.company_routes (kind, external_id, company_id) VALUES ('zalo_oa', NEW."oa_id", 1)
          ON CONFLICT (kind, external_id) DO NOTHING;
          IF NOT EXISTS (SELECT 1 FROM platform.company_routes
                         WHERE kind = 'zalo_oa' AND external_id = NEW."oa_id" AND company_id = 1) THEN
            RAISE EXCEPTION 'TRINITY_ROUTE_TAKEN: zalo_oa % is connected to another company', NEW."oa_id";
          END IF;
        END IF;
        RETURN NULL;
      END $$;

CREATE FUNCTION public.trinity_reserved_code_prefixes() RETURNS text[]
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT ARRAY['KH', 'DL', 'CV']::text[]
$$;

CREATE TABLE platform.companies (
    id integer NOT NULL,
    name character varying(200) NOT NULL,
    schema_name character varying(63) NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    migrated_to character varying(255),
    channels_locked boolean DEFAULT false NOT NULL,
    channels_lock_reason text,
    channels_locked_at timestamp with time zone
);

CREATE SEQUENCE platform.companies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE platform.companies_id_seq OWNED BY platform.companies.id;

CREATE TABLE platform.company_logins (
    email character varying(255) NOT NULL,
    company_id integer NOT NULL
);

CREATE TABLE platform.company_routes (
    kind character varying(32) NOT NULL,
    external_id character varying(255) NOT NULL,
    company_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.active_sessions (
    user_id integer NOT NULL,
    session_id character varying(64) NOT NULL,
    started_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.activities (
    id integer NOT NULL,
    contact_id integer,
    action text NOT NULL,
    details jsonb,
    metadata jsonb,
    created_by integer,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.activities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.activities_id_seq OWNED BY public.activities.id;

CREATE TABLE public.ai_action_drafts (
    id integer NOT NULL,
    user_id integer NOT NULL,
    client_id character varying(512) NOT NULL,
    tool character varying(64) NOT NULL,
    params jsonb NOT NULL,
    summary character varying(1000) NOT NULL,
    details jsonb DEFAULT '[]'::jsonb NOT NULL,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    result jsonb,
    error character varying(1000),
    impact jsonb,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    decided_at timestamp(3) with time zone,
    expires_at timestamp(3) with time zone NOT NULL
);

CREATE SEQUENCE public.ai_action_drafts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.ai_action_drafts_id_seq OWNED BY public.ai_action_drafts.id;

CREATE TABLE public.api_keys (
    id integer NOT NULL,
    name character varying(120) NOT NULL,
    prefix character varying(32) NOT NULL,
    key_hash character varying(128) NOT NULL,
    scopes text[] DEFAULT ARRAY[]::text[],
    owner_user_id integer NOT NULL,
    created_by integer NOT NULL,
    last_used_at timestamp(3) with time zone,
    last_used_ip text,
    expires_at timestamp(3) with time zone,
    revoked_at timestamp(3) with time zone,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL
);

CREATE SEQUENCE public.api_keys_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.api_keys_id_seq OWNED BY public.api_keys.id;

CREATE TABLE public.attendance_offices (
    id integer NOT NULL,
    name text NOT NULL,
    description text,
    ips text[],
    is_active boolean DEFAULT true NOT NULL,
    is_demo boolean DEFAULT false NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL
);

CREATE SEQUENCE public.attendance_offices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.attendance_offices_id_seq OWNED BY public.attendance_offices.id;

CREATE TABLE public.attendance_qr_sessions (
    id integer NOT NULL,
    token text NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    expires_at timestamp(3) with time zone NOT NULL,
    is_active boolean DEFAULT true NOT NULL
);

CREATE SEQUENCE public.attendance_qr_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.attendance_qr_sessions_id_seq OWNED BY public.attendance_qr_sessions.id;

CREATE TABLE public.attendance_records (
    id integer NOT NULL,
    user_id integer NOT NULL,
    employee_id integer,
    work_date date NOT NULL,
    check_in_at timestamp(3) with time zone,
    check_out_at timestamp(3) with time zone,
    check_in_proof_key text,
    check_out_proof_key text,
    check_in_lat double precision,
    check_in_lng double precision,
    check_out_lat double precision,
    check_out_lng double precision,
    check_in_note text,
    check_out_note text,
    total_hours double precision,
    overtime_hours double precision,
    late_minutes integer,
    status text DEFAULT 'incomplete'::text NOT NULL,
    check_in_ip text,
    check_out_ip text,
    check_in_office_id integer,
    check_out_office_id integer,
    device_id text,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL
);

CREATE SEQUENCE public.attendance_records_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.attendance_records_id_seq OWNED BY public.attendance_records.id;

CREATE TABLE public.attendance_requests (
    id integer NOT NULL,
    user_id integer NOT NULL,
    work_date date NOT NULL,
    type text NOT NULL,
    requested_check_in text,
    requested_check_out text,
    reason text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    reviewed_by integer,
    reviewed_at timestamp(3) with time zone,
    review_note text,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL
);

CREATE SEQUENCE public.attendance_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.attendance_requests_id_seq OWNED BY public.attendance_requests.id;

CREATE TABLE public.audit_logs (
    id integer NOT NULL,
    user_id integer,
    action text NOT NULL,
    resource text NOT NULL,
    resource_id integer,
    metadata jsonb,
    ip_address text,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.audit_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.audit_logs_id_seq OWNED BY public.audit_logs.id;

CREATE TABLE public.briefings (
    id integer NOT NULL,
    user_id integer NOT NULL,
    slot character varying(16) NOT NULL,
    day character varying(10) NOT NULL,
    title character varying(200) NOT NULL,
    text text NOT NULL,
    data jsonb NOT NULL,
    channels jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.briefings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.briefings_id_seq OWNED BY public.briefings.id;

CREATE TABLE public.channel_events (
    id integer NOT NULL,
    kind character varying(32) NOT NULL,
    message text NOT NULL,
    meta jsonb,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.channel_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.channel_events_id_seq OWNED BY public.channel_events.id;

CREATE TABLE public.channel_usage (
    kind character varying(32) NOT NULL,
    bucket timestamp(3) with time zone NOT NULL,
    count integer DEFAULT 0 NOT NULL
);

CREATE TABLE public.connector_accounts (
    id integer NOT NULL,
    provider character varying(32) NOT NULL,
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    credentials_enc text NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_error character varying(300),
    last_event_at timestamp(3) with time zone,
    connected_by integer NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

COMMENT ON TABLE public.connector_accounts IS 'LƯU TRỮ: kết nối bán hàng/sàn và cổng thanh toán đã gỡ (G06/G07b), khoá đã xoá. Giữ dòng cũ.';

CREATE SEQUENCE public.connector_accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.connector_accounts_id_seq OWNED BY public.connector_accounts.id;

CREATE TABLE public.connector_events (
    id integer NOT NULL,
    provider character varying(32) NOT NULL,
    external_id character varying(100) NOT NULL,
    kind character varying(32) NOT NULL,
    amount bigint,
    content character varying(500),
    reference character varying(100),
    status character varying(16) NOT NULL,
    payment_intent_id integer,
    raw jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp(3) with time zone,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

COMMENT ON TABLE public.connector_events IS 'LƯU TRỮ: sự kiện từ kết nối bán hàng/sàn và cổng thanh toán đã gỡ. Không còn mã đọc/ghi; giữ dữ liệu cũ.';

CREATE SEQUENCE public.connector_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.connector_events_id_seq OWNED BY public.connector_events.id;

CREATE TABLE public.connector_records (
    id integer NOT NULL,
    provider character varying(32) NOT NULL,
    account character varying(80) DEFAULT ''::character varying NOT NULL,
    kind character varying(16) NOT NULL,
    external_id character varying(64) NOT NULL,
    code character varying(64),
    name character varying(255),
    contact_id integer,
    amount bigint,
    status character varying(40),
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    external_updated_at timestamp(3) with time zone,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

COMMENT ON TABLE public.connector_records IS 'LƯU TRỮ: bản ghi đồng bộ từ phần mềm bán hàng/sàn đã gỡ (G06). Không còn mã đọc/ghi; giữ dữ liệu cũ.';

CREATE SEQUENCE public.connector_records_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.connector_records_id_seq OWNED BY public.connector_records.id;

CREATE TABLE public.contact_recent_views (
    id integer NOT NULL,
    user_id integer NOT NULL,
    contact_id integer NOT NULL,
    viewed_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.contact_recent_views_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.contact_recent_views_id_seq OWNED BY public.contact_recent_views.id;

CREATE TABLE public.contacts (
    id integer NOT NULL,
    code character varying(24),
    phone text NOT NULL,
    phone_2 text,
    zalo_account text,
    full_name text,
    source_id integer,
    source_locked boolean DEFAULT false NOT NULL,
    stage_id integer,
    contact_status_id integer,
    reminder_at timestamp(3) with time zone,
    reminder_notes text,
    birthday timestamp(3) with time zone,
    job_title text,
    assigned_to integer,
    team_id integer,
    created_by_id integer,
    gender text,
    current_address text,
    company_name text,
    email text,
    custom_fields jsonb DEFAULT '[]'::jsonb NOT NULL,
    project_id integer,
    product_id integer,
    avatar_url text,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL,
    deleted_at timestamp(3) without time zone,
    lead_score integer,
    lead_label character varying(8),
    lead_score_reasons jsonb,
    lead_scored_at timestamp(3) with time zone,
    deleted_by_id integer
);

CREATE SEQUENCE public.contacts_code_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE SEQUENCE public.contacts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.contacts_id_seq OWNED BY public.contacts.id;

CREATE TABLE public.contract_templates (
    id integer NOT NULL,
    name text NOT NULL,
    storage_key text NOT NULL,
    mime text NOT NULL,
    size integer NOT NULL,
    uploaded_by integer,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.contract_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.contract_templates_id_seq OWNED BY public.contract_templates.id;

CREATE TABLE public.custom_fields (
    id integer NOT NULL,
    object_id integer NOT NULL,
    key character varying(48) NOT NULL,
    label character varying(100) NOT NULL,
    type character varying(16) NOT NULL,
    required boolean DEFAULT false NOT NULL,
    is_unique boolean DEFAULT false NOT NULL,
    is_title boolean DEFAULT false NOT NULL,
    show_in_list boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    options jsonb DEFAULT '{}'::jsonb NOT NULL,
    help_text character varying(300),
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp(3) with time zone
);

CREATE SEQUENCE public.custom_fields_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.custom_fields_id_seq OWNED BY public.custom_fields.id;

CREATE TABLE public.custom_objects (
    id integer NOT NULL,
    key character varying(48) NOT NULL,
    label character varying(100) NOT NULL,
    label_plural character varying(100) NOT NULL,
    icon character varying(48),
    description character varying(500),
    show_in_nav boolean DEFAULT true NOT NULL,
    nav_order integer DEFAULT 0 NOT NULL,
    visible_role_ids integer[] DEFAULT ARRAY[]::integer[],
    is_active boolean DEFAULT true NOT NULL,
    code_prefix character varying(8),
    code_prefix_aliases character varying(8)[] DEFAULT (ARRAY[]::character varying[])::character varying(8)[],
    next_code_seq integer,
    created_by integer,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp(3) with time zone
);

CREATE SEQUENCE public.custom_objects_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.custom_objects_id_seq OWNED BY public.custom_objects.id;

CREATE TABLE public.custom_records (
    id integer NOT NULL,
    object_id integer NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    title character varying(200),
    code character varying(24),
    code_seq integer,
    owner_id integer,
    created_by integer,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp(3) with time zone
);

CREATE SEQUENCE public.custom_records_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.custom_records_id_seq OWNED BY public.custom_records.id;

CREATE TABLE public.custom_schema_versions (
    id integer NOT NULL,
    draft_id integer,
    tool character varying(64) NOT NULL,
    summary character varying(1000) NOT NULL,
    snapshot jsonb NOT NULL,
    created_by integer,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.custom_schema_versions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.custom_schema_versions_id_seq OWNED BY public.custom_schema_versions.id;

CREATE TABLE public.custom_views (
    id integer NOT NULL,
    object_id integer NOT NULL,
    key character varying(48) NOT NULL,
    label character varying(100) NOT NULL,
    type character varying(16) NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    icon character varying(48),
    show_in_nav boolean DEFAULT false NOT NULL,
    nav_order integer DEFAULT 0 NOT NULL,
    visible_role_ids integer[] DEFAULT ARRAY[]::integer[],
    created_by integer,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp(3) with time zone
);

CREATE SEQUENCE public.custom_views_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.custom_views_id_seq OWNED BY public.custom_views.id;

CREATE TABLE public.deals (
    id integer NOT NULL,
    code character varying(24),
    title text NOT NULL,
    description text,
    value bigint,
    status text DEFAULT 'open'::text NOT NULL,
    note text,
    assigned_to integer NOT NULL,
    created_by integer NOT NULL,
    contact_id integer,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL,
    won_at timestamp(3) with time zone
);

CREATE SEQUENCE public.deals_code_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE SEQUENCE public.deals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.deals_id_seq OWNED BY public.deals.id;

CREATE TABLE public.employee_contracts (
    id integer NOT NULL,
    employee_id integer NOT NULL,
    contract_type text DEFAULT 'co_thoi_han'::text NOT NULL,
    signed_date timestamp(3) with time zone NOT NULL,
    end_date timestamp(3) with time zone,
    file_url text,
    notes text,
    is_terminated boolean DEFAULT false NOT NULL,
    terminated_at timestamp(3) with time zone,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL
);

CREATE SEQUENCE public.employee_contracts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.employee_contracts_id_seq OWNED BY public.employee_contracts.id;

CREATE TABLE public.employees (
    id integer NOT NULL,
    user_id integer NOT NULL,
    employee_code character varying(50),
    "position" text NOT NULL,
    department text,
    gender text,
    team_id integer,
    salary_rule_id integer,
    job_title_id integer,
    insurance_salary bigint,
    dependents_count integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    resigned_at timestamp(3) with time zone,
    education_level text,
    recruitment_source text,
    deleted_at timestamp(3) with time zone,
    joined_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    office_id integer,
    registered_device_id character varying(255),
    device_registered_at timestamp(3) with time zone,
    birth_date timestamp(3) with time zone,
    id_card_number character varying(20),
    id_card_issued_date timestamp(3) with time zone,
    id_card_issued_place text,
    permanent_address text,
    current_address text,
    bank_account_number character varying(30),
    bank_name text,
    bank_account_holder text
);

CREATE SEQUENCE public.employees_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.employees_id_seq OWNED BY public.employees.id;

CREATE TABLE public.employment_periods (
    id integer NOT NULL,
    employee_id integer NOT NULL,
    started_on date,
    ended_on date,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.employment_periods_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.employment_periods_id_seq OWNED BY public.employment_periods.id;

CREATE TABLE public.extension_runs (
    id integer NOT NULL,
    extension_id integer NOT NULL,
    version_id integer,
    mode character varying(10) NOT NULL,
    outcome character varying(20) NOT NULL,
    duration_ms integer DEFAULT 0 NOT NULL,
    peak_rss_kb integer,
    log text DEFAULT ''::text NOT NULL,
    result jsonb,
    started_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

COMMENT ON TABLE public.extension_runs IS 'LƯU TRỮ: nhật ký chạy chương trình con đã gỡ (G02). Không còn mã đọc/ghi; giữ dữ liệu cũ.';

CREATE SEQUENCE public.extension_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.extension_runs_id_seq OWNED BY public.extension_runs.id;

CREATE TABLE public.extension_versions (
    id integer NOT NULL,
    extension_id integer NOT NULL,
    version integer NOT NULL,
    code text NOT NULL,
    manifest jsonb NOT NULL,
    note character varying(500),
    review_status character varying(10) DEFAULT 'draft'::character varying NOT NULL,
    review_note character varying(1000),
    created_by integer NOT NULL,
    reviewed_by integer,
    reviewed_at timestamp(3) with time zone,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

COMMENT ON TABLE public.extension_versions IS 'LƯU TRỮ: phiên bản chương trình con đã gỡ (G02). Không còn mã đọc/ghi; giữ dữ liệu cũ.';

CREATE SEQUENCE public.extension_versions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.extension_versions_id_seq OWNED BY public.extension_versions.id;

CREATE TABLE public.extensions (
    id integer NOT NULL,
    key character varying(40) NOT NULL,
    kind character varying(8) NOT NULL,
    name character varying(120) NOT NULL,
    description character varying(1000) DEFAULT ''::character varying NOT NULL,
    status character varying(12) DEFAULT 'draft'::character varying NOT NULL,
    active_version_id integer,
    latest_version integer DEFAULT 0 NOT NULL,
    disabled_reason character varying(1000),
    consecutive_failures integer DEFAULT 0 NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp(3) with time zone
);

COMMENT ON TABLE public.extensions IS 'LƯU TRỮ: chương trình con (extension) đã gỡ (G02). Không còn mã đọc/ghi; giữ dữ liệu cũ.';

CREATE SEQUENCE public.extensions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.extensions_id_seq OWNED BY public.extensions.id;

CREATE TABLE public.facebook_broadcast_recipients (
    id integer NOT NULL,
    broadcast_id integer NOT NULL,
    conversation_id integer NOT NULL,
    status character varying(16) DEFAULT 'queued'::character varying NOT NULL,
    note character varying(300),
    claimed_at timestamp(3) with time zone,
    sent_at timestamp(3) with time zone
);

CREATE SEQUENCE public.facebook_broadcast_recipients_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.facebook_broadcast_recipients_id_seq OWNED BY public.facebook_broadcast_recipients.id;

CREATE TABLE public.facebook_broadcasts (
    id integer NOT NULL,
    name character varying(120) NOT NULL,
    page_id character varying(40) NOT NULL,
    text text NOT NULL,
    audience jsonb DEFAULT '{}'::jsonb NOT NULL,
    status character varying(16) DEFAULT 'draft'::character varying NOT NULL,
    scheduled_at timestamp(3) with time zone,
    total integer DEFAULT 0 NOT NULL,
    sent integer DEFAULT 0 NOT NULL,
    failed integer DEFAULT 0 NOT NULL,
    skipped integer DEFAULT 0 NOT NULL,
    source character varying(20) DEFAULT 'web'::character varying NOT NULL,
    created_by integer NOT NULL,
    started_at timestamp(3) with time zone,
    finished_at timestamp(3) with time zone,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.facebook_broadcasts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.facebook_broadcasts_id_seq OWNED BY public.facebook_broadcasts.id;

CREATE TABLE public.facebook_chat_links (
    id integer NOT NULL,
    code character varying(32) NOT NULL,
    name character varying(120) NOT NULL,
    page_id character varying(40) NOT NULL,
    source_id integer,
    is_active boolean DEFAULT true NOT NULL,
    clicks integer DEFAULT 0 NOT NULL,
    chats integer DEFAULT 0 NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL
);

CREATE SEQUENCE public.facebook_chat_links_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.facebook_chat_links_id_seq OWNED BY public.facebook_chat_links.id;

CREATE TABLE public.facebook_comment_rules (
    id integer NOT NULL,
    name character varying(120) NOT NULL,
    page_id character varying(40),
    post_id character varying(80),
    keywords text[] DEFAULT ARRAY[]::text[],
    exclude_keywords text[] DEFAULT ARRAY[]::text[],
    public_replies text[] DEFAULT ARRAY[]::text[],
    private_reply text,
    hide_if_phone boolean DEFAULT false NOT NULL,
    once_per_user boolean DEFAULT true NOT NULL,
    mode character varying(8) DEFAULT 'test'::character varying NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.facebook_comment_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.facebook_comment_rules_id_seq OWNED BY public.facebook_comment_rules.id;

CREATE TABLE public.facebook_comments (
    id bigint NOT NULL,
    comment_id character varying(80) NOT NULL,
    page_id character varying(40) NOT NULL,
    post_id character varying(80) NOT NULL,
    parent_id character varying(80),
    from_id character varying(40),
    from_name character varying(200),
    message text,
    commented_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    contact_id integer,
    phone character varying(20),
    rule_id integer,
    status character varying(12) DEFAULT 'received'::character varying NOT NULL,
    note character varying(500),
    actions jsonb DEFAULT '{}'::jsonb NOT NULL,
    hidden boolean DEFAULT false NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.facebook_comments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.facebook_comments_id_seq OWNED BY public.facebook_comments.id;

CREATE TABLE public.facebook_conversations (
    id integer NOT NULL,
    page_id character varying(40) NOT NULL,
    psid character varying(40) NOT NULL,
    customer_name character varying(200),
    contact_id integer,
    last_inbound_at timestamp(3) with time zone,
    last_message_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_message_preview character varying(200),
    unread_count integer DEFAULT 0 NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    entry_link_id integer
);

CREATE SEQUENCE public.facebook_conversations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.facebook_conversations_id_seq OWNED BY public.facebook_conversations.id;

CREATE TABLE public.facebook_flow_runs (
    id integer NOT NULL,
    flow_id integer NOT NULL,
    conversation_id integer NOT NULL,
    step_id character varying(16),
    status character varying(16) NOT NULL,
    due_at timestamp(3) with time zone,
    note character varying(300),
    started_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL
);

CREATE SEQUENCE public.facebook_flow_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.facebook_flow_runs_id_seq OWNED BY public.facebook_flow_runs.id;

CREATE TABLE public.facebook_flows (
    id integer NOT NULL,
    name character varying(120) NOT NULL,
    page_id character varying(40) NOT NULL,
    trigger character varying(16) NOT NULL,
    keywords text[] DEFAULT ARRAY[]::text[],
    chat_link_id integer,
    steps jsonb NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    starts integer DEFAULT 0 NOT NULL,
    completes integer DEFAULT 0 NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL
);

CREATE SEQUENCE public.facebook_flows_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.facebook_flows_id_seq OWNED BY public.facebook_flows.id;

CREATE TABLE public.facebook_lead_receipts (
    id bigint NOT NULL,
    leadgen_id character varying(40) NOT NULL,
    page_id character varying(40) NOT NULL,
    form_id character varying(40),
    contact_id integer,
    result character varying(20) NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.facebook_lead_receipts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.facebook_lead_receipts_id_seq OWNED BY public.facebook_lead_receipts.id;

CREATE TABLE public.facebook_messages (
    id bigint NOT NULL,
    conversation_id integer NOT NULL,
    mid character varying(255) NOT NULL,
    direction character varying(3) NOT NULL,
    text text,
    sent_by_user_id integer,
    sent_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.facebook_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.facebook_messages_id_seq OWNED BY public.facebook_messages.id;

CREATE TABLE public.facebook_pages (
    id integer NOT NULL,
    page_id character varying(40) NOT NULL,
    name character varying(200) NOT NULL,
    token_enc text NOT NULL,
    token_status character varying(16) DEFAULT 'unknown'::character varying NOT NULL,
    token_checked_at timestamp(3) with time zone,
    token_expires_at timestamp(3) with time zone,
    data_access_expires_at timestamp(3) with time zone,
    subscribed boolean DEFAULT false NOT NULL,
    default_assignee_id integer NOT NULL,
    contact_source_id integer NOT NULL,
    project_id integer,
    is_active boolean DEFAULT true NOT NULL,
    connected_by integer NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.facebook_pages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.facebook_pages_id_seq OWNED BY public.facebook_pages.id;

CREATE TABLE public.google_connections (
    id integer NOT NULL,
    google_email character varying(255),
    refresh_token_enc text,
    access_token_enc text,
    token_expires_at timestamp(3) with time zone,
    scopes text[] DEFAULT ARRAY[]::text[],
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    last_error character varying(500),
    created_by integer NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

COMMENT ON TABLE public.google_connections IS 'LƯU TRỮ: tích hợp Google đã gỡ (G02/G03). Không còn mã đọc/ghi; giữ dữ liệu cũ.';

CREATE SEQUENCE public.google_connections_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.google_connections_id_seq OWNED BY public.google_connections.id;

CREATE TABLE public.google_sheet_sync_runs (
    id bigint NOT NULL,
    sync_id integer NOT NULL,
    trigger character varying(16) NOT NULL,
    started_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    finished_at timestamp(3) with time zone,
    status character varying(16) DEFAULT 'running'::character varying NOT NULL,
    stats jsonb DEFAULT '{}'::jsonb NOT NULL,
    error character varying(500)
);

COMMENT ON TABLE public.google_sheet_sync_runs IS 'LƯU TRỮ: nhật ký đồng bộ Google Sheets đã gỡ. Không còn mã đọc/ghi; giữ dữ liệu cũ.';

CREATE SEQUENCE public.google_sheet_sync_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.google_sheet_sync_runs_id_seq OWNED BY public.google_sheet_sync_runs.id;

CREATE TABLE public.google_sheet_syncs (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    direction character varying(8) NOT NULL,
    connection_id integer NOT NULL,
    spreadsheet_id character varying(128) NOT NULL,
    sheet_title character varying(200) NOT NULL,
    target_kind character varying(16) NOT NULL,
    target_object_key character varying(48),
    column_map jsonb DEFAULT '{}'::jsonb NOT NULL,
    dedupe_key character varying(48) NOT NULL,
    actor_user_id integer NOT NULL,
    contact_source_id integer,
    schedule_minutes integer,
    is_active boolean DEFAULT true NOT NULL,
    export_cursor bigint DEFAULT 0 NOT NULL,
    last_run_at timestamp(3) with time zone,
    last_status character varying(16),
    last_error character varying(500),
    created_by integer NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp(3) with time zone
);

COMMENT ON TABLE public.google_sheet_syncs IS 'LƯU TRỮ: đồng bộ Google Sheets đã gỡ. Không còn mã đọc/ghi; giữ dữ liệu cũ.';

CREATE SEQUENCE public.google_sheet_syncs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.google_sheet_syncs_id_seq OWNED BY public.google_sheet_syncs.id;

CREATE TABLE public.insurance_settings (
    id integer NOT NULL,
    name text NOT NULL,
    code text NOT NULL,
    employee_rate numeric(5,2) NOT NULL,
    base_cap bigint,
    effective_from text NOT NULL,
    effective_to text,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_by integer,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL
);

CREATE SEQUENCE public.insurance_settings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.insurance_settings_id_seq OWNED BY public.insurance_settings.id;

CREATE TABLE public.integration_audit_logs (
    id bigint NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    channel character varying(16) NOT NULL,
    client_id character varying(255),
    user_id integer,
    action character varying(128) NOT NULL,
    resource character varying(64),
    resource_id character varying(64),
    status character varying(16) NOT NULL,
    http_status integer,
    duration_ms integer,
    error character varying(500),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE SEQUENCE public.integration_audit_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.integration_audit_logs_id_seq OWNED BY public.integration_audit_logs.id;

CREATE TABLE public.integration_events (
    id bigint NOT NULL,
    event_type character varying(64) NOT NULL,
    resource character varying(32) NOT NULL,
    resource_id character varying(64) NOT NULL,
    payload jsonb NOT NULL,
    actor_user_id integer,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    dispatched_at timestamp(3) with time zone
);

CREATE SEQUENCE public.integration_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.integration_events_id_seq OWNED BY public.integration_events.id;

CREATE TABLE public.job_titles (
    id integer NOT NULL,
    category text NOT NULL,
    rank_code text NOT NULL,
    name text NOT NULL,
    symbol text NOT NULL,
    base_salary bigint DEFAULT 0 NOT NULL,
    standard_target bigint DEFAULT 0 NOT NULL,
    default_insurance_salary bigint,
    review_cycle_months integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL
);

CREATE SEQUENCE public.job_titles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.job_titles_id_seq OWNED BY public.job_titles.id;

CREATE TABLE public.kanban_boards (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    icon character varying(64),
    color character varying(32),
    is_active boolean DEFAULT true NOT NULL,
    visibility_role_ids integer[] DEFAULT ARRAY[]::integer[],
    card_prefix character varying(16),
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    label_defs jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_by integer,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp(6) with time zone
);

CREATE SEQUENCE public.kanban_boards_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.kanban_boards_id_seq OWNED BY public.kanban_boards.id;

CREATE TABLE public.kanban_card_activities (
    id integer NOT NULL,
    card_id integer NOT NULL,
    actor_id integer,
    action character varying(32) NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.kanban_card_activities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.kanban_card_activities_id_seq OWNED BY public.kanban_card_activities.id;

CREATE TABLE public.kanban_card_assignees (
    id integer NOT NULL,
    card_id integer NOT NULL,
    user_id integer NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.kanban_card_assignees_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.kanban_card_assignees_id_seq OWNED BY public.kanban_card_assignees.id;

CREATE TABLE public.kanban_card_attachments (
    id integer NOT NULL,
    card_id integer NOT NULL,
    url text NOT NULL,
    title character varying(255),
    created_by integer NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.kanban_card_attachments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.kanban_card_attachments_id_seq OWNED BY public.kanban_card_attachments.id;

CREATE TABLE public.kanban_cards (
    id integer NOT NULL,
    code character varying(24),
    board_id integer NOT NULL,
    column_id integer NOT NULL,
    "position" double precision NOT NULL,
    title character varying(500) NOT NULL,
    description text,
    contact_id integer,
    assignee_id integer,
    created_by integer NOT NULL,
    due_at timestamp(6) with time zone,
    priority character varying(16),
    labels text[] DEFAULT ARRAY[]::text[],
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    completed_at timestamp(6) with time zone,
    due_completed_at timestamp(6) with time zone,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp(6) with time zone,
    deleted_by integer
);

CREATE SEQUENCE public.kanban_cards_code_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE SEQUENCE public.kanban_cards_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.kanban_cards_id_seq OWNED BY public.kanban_cards.id;

CREATE TABLE public.kanban_checklist_items (
    id integer NOT NULL,
    card_id integer NOT NULL,
    text character varying(500) NOT NULL,
    is_done boolean DEFAULT false NOT NULL,
    "position" double precision NOT NULL,
    created_by integer,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.kanban_checklist_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.kanban_checklist_items_id_seq OWNED BY public.kanban_checklist_items.id;

CREATE TABLE public.kanban_columns (
    id integer NOT NULL,
    board_id integer NOT NULL,
    name character varying(255) NOT NULL,
    color character varying(32),
    "position" double precision NOT NULL,
    wip_limit integer,
    is_done boolean DEFAULT false NOT NULL,
    is_archived boolean DEFAULT false NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.kanban_columns_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.kanban_columns_id_seq OWNED BY public.kanban_columns.id;

CREATE TABLE public.kanban_field_defs (
    id integer NOT NULL,
    board_id integer NOT NULL,
    key character varying(64) NOT NULL,
    label character varying(255) NOT NULL,
    type character varying(32) NOT NULL,
    options jsonb,
    required boolean DEFAULT false NOT NULL,
    show_on_card boolean DEFAULT false NOT NULL,
    "position" double precision DEFAULT 0 NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.kanban_field_defs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.kanban_field_defs_id_seq OWNED BY public.kanban_field_defs.id;

CREATE TABLE public.kpi_configs (
    id integer NOT NULL,
    role text NOT NULL,
    metric_name text NOT NULL,
    target numeric(15,2) NOT NULL,
    unit text,
    weight numeric(5,2),
    working_days_per_month integer DEFAULT 24 NOT NULL
);

CREATE SEQUENCE public.kpi_configs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.kpi_configs_id_seq OWNED BY public.kpi_configs.id;

CREATE TABLE public.kpi_results (
    id integer NOT NULL,
    employee_id integer NOT NULL,
    month text NOT NULL,
    metric_name text NOT NULL,
    actual_value numeric(15,2) NOT NULL,
    target_value numeric(15,2) NOT NULL,
    achievement_rate numeric(5,2),
    achieved boolean DEFAULT false NOT NULL,
    is_locked boolean DEFAULT false NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.kpi_results_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.kpi_results_id_seq OWNED BY public.kpi_results.id;

CREATE TABLE public.lead_ai_intents (
    contact_id integer NOT NULL,
    intent double precision NOT NULL,
    reason character varying(300),
    client_id character varying(120),
    user_id integer,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.login_wifi_check_targets (
    id integer NOT NULL,
    scope_type character varying(20) NOT NULL,
    target_user_id integer NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by integer
);

CREATE SEQUENCE public.login_wifi_check_targets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.login_wifi_check_targets_id_seq OWNED BY public.login_wifi_check_targets.id;

CREATE TABLE public.newsfeed_post_comments (
    id integer NOT NULL,
    post_id integer NOT NULL,
    user_id integer NOT NULL,
    content text NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.newsfeed_post_comments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.newsfeed_post_comments_id_seq OWNED BY public.newsfeed_post_comments.id;

CREATE TABLE public.newsfeed_post_images (
    id integer NOT NULL,
    post_id integer NOT NULL,
    image_url text NOT NULL,
    media_type public."NewsfeedMediaType" DEFAULT 'image'::public."NewsfeedMediaType" NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.newsfeed_post_images_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.newsfeed_post_images_id_seq OWNED BY public.newsfeed_post_images.id;

CREATE TABLE public.newsfeed_post_likes (
    id integer NOT NULL,
    post_id integer NOT NULL,
    user_id integer NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.newsfeed_post_likes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.newsfeed_post_likes_id_seq OWNED BY public.newsfeed_post_likes.id;

CREATE TABLE public.newsfeed_posts (
    id integer NOT NULL,
    category text NOT NULL,
    author_id integer NOT NULL,
    content text NOT NULL,
    image_url text,
    edited_at timestamp(3) with time zone,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL
);

CREATE SEQUENCE public.newsfeed_posts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.newsfeed_posts_id_seq OWNED BY public.newsfeed_posts.id;

CREATE TABLE public.notification_logs (
    id integer NOT NULL,
    recipient_id integer NOT NULL,
    template_id integer,
    event_type text,
    channel text NOT NULL,
    title text,
    body text,
    status text DEFAULT 'sent'::text NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    read_at timestamp(3) with time zone,
    error text,
    scheduled_at timestamp(3) with time zone,
    action_url text,
    sent_at timestamp(3) with time zone,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    webhook_url text,
    claimed_at timestamp(3) with time zone
);

CREATE SEQUENCE public.notification_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.notification_logs_id_seq OWNED BY public.notification_logs.id;

CREATE TABLE public.notification_templates (
    id integer NOT NULL,
    name text NOT NULL,
    event_type text,
    channel text NOT NULL,
    subject text,
    body text NOT NULL,
    recipients_rule jsonb,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL
);

CREATE SEQUENCE public.notification_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.notification_templates_id_seq OWNED BY public.notification_templates.id;

CREATE TABLE public.oauth_authorization_codes (
    id bigint NOT NULL,
    code_hash character varying(64) NOT NULL,
    client_id character varying(512) NOT NULL,
    user_id integer NOT NULL,
    redirect_uri character varying(2048) NOT NULL,
    code_challenge character varying(128) NOT NULL,
    scopes text[],
    resource character varying(512) NOT NULL,
    family_id character varying(36) NOT NULL,
    expires_at timestamp(3) with time zone NOT NULL,
    used_at timestamp(3) with time zone,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.oauth_authorization_codes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.oauth_authorization_codes_id_seq OWNED BY public.oauth_authorization_codes.id;

CREATE TABLE public.oauth_clients (
    id integer NOT NULL,
    client_id character varying(512) NOT NULL,
    kind character varying(8) NOT NULL,
    name character varying(200) NOT NULL,
    redirect_uris text[],
    logo_uri character varying(1024),
    client_uri character varying(1024),
    token_endpoint_auth_method character varying(32) DEFAULT 'none'::character varying NOT NULL,
    client_secret_hash character varying(64),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata_fetched_at timestamp(3) with time zone,
    metadata_expires_at timestamp(3) with time zone,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_used_at timestamp(3) with time zone
);

CREATE SEQUENCE public.oauth_clients_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.oauth_clients_id_seq OWNED BY public.oauth_clients.id;

CREATE TABLE public.oauth_tokens (
    id bigint NOT NULL,
    access_hash character varying(64) NOT NULL,
    refresh_hash character varying(64) NOT NULL,
    client_id character varying(512) NOT NULL,
    user_id integer NOT NULL,
    scopes text[],
    resource character varying(512) NOT NULL,
    family_id character varying(36) NOT NULL,
    access_expires_at timestamp(3) with time zone NOT NULL,
    refresh_expires_at timestamp(3) with time zone NOT NULL,
    refresh_used_at timestamp(3) with time zone,
    revoked_at timestamp(3) with time zone,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_used_at timestamp(3) with time zone
);

CREATE SEQUENCE public.oauth_tokens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.oauth_tokens_id_seq OWNED BY public.oauth_tokens.id;

CREATE TABLE public.payment_intents (
    id integer NOT NULL,
    code character varying(32) NOT NULL,
    amount bigint NOT NULL,
    description character varying(200),
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    source_type character varying(20) DEFAULT 'manual'::character varying NOT NULL,
    source_id integer,
    contact_id integer,
    paid_amount bigint,
    paid_via character varying(32),
    paid_at timestamp(3) with time zone,
    expires_at timestamp(3) with time zone,
    created_by integer,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

COMMENT ON TABLE public.payment_intents IS 'LƯU TRỮ: yêu cầu thanh toán qua cổng đã gỡ (G07b). Không còn mã đọc/ghi; giữ dữ liệu cũ.';

CREATE SEQUENCE public.payment_intents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.payment_intents_id_seq OWNED BY public.payment_intents.id;

CREATE TABLE public.payroll_tax_settings (
    id integer NOT NULL,
    personal_deduction bigint NOT NULL,
    dependent_deduction bigint NOT NULL,
    effective_from text NOT NULL,
    effective_to text,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL
);

CREATE SEQUENCE public.payroll_tax_settings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.payroll_tax_settings_id_seq OWNED BY public.payroll_tax_settings.id;

CREATE TABLE public.payslips (
    id integer NOT NULL,
    employee_id integer NOT NULL,
    month text NOT NULL,
    base_salary bigint DEFAULT 0 NOT NULL,
    kpi_bonus bigint DEFAULT 0 NOT NULL,
    deductions bigint DEFAULT 0 NOT NULL,
    total bigint DEFAULT 0 NOT NULL,
    components_json jsonb,
    insurance_json jsonb,
    insurance_base bigint DEFAULT 0 NOT NULL,
    tax_json jsonb,
    working_days numeric(5,1),
    standard_working_days integer DEFAULT 24 NOT NULL,
    base_salary_actual bigint DEFAULT 0 NOT NULL,
    training_salary bigint DEFAULT 0 NOT NULL,
    probation_allowance bigint DEFAULT 0 NOT NULL,
    sales_personal bigint DEFAULT 0 NOT NULL,
    bonus_rate numeric(7,4),
    kpi_percent numeric(5,2),
    bonus_sales_personal bigint DEFAULT 0 NOT NULL,
    sales_team bigint DEFAULT 0 NOT NULL,
    bonus_cskh_team bigint DEFAULT 0 NOT NULL,
    bonus_milestone bigint DEFAULT 0 NOT NULL,
    bonus_referral bigint DEFAULT 0 NOT NULL,
    holiday_bonus bigint DEFAULT 0 NOT NULL,
    advances bigint DEFAULT 0 NOT NULL,
    training_days numeric(5,1),
    personal_income_tax bigint DEFAULT 0 NOT NULL,
    notes text,
    status text DEFAULT 'draft'::text NOT NULL,
    tl_approved_by integer,
    tl_approved_at timestamp(3) with time zone,
    approved_by integer,
    approved_at timestamp(3) with time zone,
    deleted_at timestamp(3) with time zone,
    deleted_by integer,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL
);

CREATE SEQUENCE public.payslips_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.payslips_id_seq OWNED BY public.payslips.id;

CREATE TABLE public.pos_areas (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.pos_areas_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.pos_areas_id_seq OWNED BY public.pos_areas.id;

CREATE TABLE public.pos_modifiers (
    id integer NOT NULL,
    group_name character varying(100) NOT NULL,
    name character varying(100) NOT NULL,
    price_delta bigint DEFAULT 0 NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.pos_modifiers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.pos_modifiers_id_seq OWNED BY public.pos_modifiers.id;

CREATE TABLE public.pos_order_items (
    id integer NOT NULL,
    order_id integer NOT NULL,
    product_id integer NOT NULL,
    product_name character varying(255) NOT NULL,
    unit_price bigint NOT NULL,
    quantity integer NOT NULL,
    options jsonb DEFAULT '[]'::jsonb NOT NULL,
    note character varying(255),
    line_total bigint NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.pos_order_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.pos_order_items_id_seq OWNED BY public.pos_order_items.id;

CREATE TABLE public.pos_orders (
    id integer NOT NULL,
    code character varying(20) NOT NULL,
    shift_id integer NOT NULL,
    table_id integer,
    order_type character varying(16) DEFAULT 'dine_in'::character varying NOT NULL,
    status character varying(16) DEFAULT 'open'::character varying NOT NULL,
    note character varying(500),
    subtotal bigint DEFAULT 0 NOT NULL,
    discount_type character varying(16) DEFAULT 'none'::character varying NOT NULL,
    discount_value bigint DEFAULT 0 NOT NULL,
    discount_amount bigint DEFAULT 0 NOT NULL,
    total bigint DEFAULT 0 NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    paid_by integer,
    paid_at timestamp(6) with time zone,
    voided_by integer,
    voided_at timestamp(6) with time zone,
    void_reason character varying(500)
);

CREATE SEQUENCE public.pos_orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.pos_orders_id_seq OWNED BY public.pos_orders.id;

CREATE TABLE public.pos_payments (
    id integer NOT NULL,
    order_id integer NOT NULL,
    shift_id integer NOT NULL,
    method character varying(16) NOT NULL,
    amount bigint NOT NULL,
    tendered bigint,
    change bigint DEFAULT 0 NOT NULL,
    reference character varying(100),
    created_by integer NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.pos_payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.pos_payments_id_seq OWNED BY public.pos_payments.id;

CREATE TABLE public.pos_settings (
    id integer DEFAULT 1 NOT NULL,
    store_name character varying(255) DEFAULT 'Quán của tôi'::character varying NOT NULL,
    address character varying(500),
    phone character varying(32),
    receipt_footer character varying(500),
    bank_bin character varying(8),
    bank_account_no character varying(32),
    bank_account_name character varying(255),
    menu_category_ids integer[] DEFAULT ARRAY[]::integer[],
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.pos_shifts (
    id integer NOT NULL,
    opened_by integer NOT NULL,
    opened_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    opening_cash bigint DEFAULT 0 NOT NULL,
    status character varying(16) DEFAULT 'open'::character varying NOT NULL,
    closed_by integer,
    closed_at timestamp(6) with time zone,
    closing_cash_counted bigint,
    expected_cash bigint,
    cash_diff bigint,
    note character varying(500)
);

CREATE SEQUENCE public.pos_shifts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.pos_shifts_id_seq OWNED BY public.pos_shifts.id;

CREATE TABLE public.pos_tables (
    id integer NOT NULL,
    area_id integer NOT NULL,
    name character varying(50) NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.pos_tables_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.pos_tables_id_seq OWNED BY public.pos_tables.id;

CREATE TABLE public.product_attribute_defs (
    id integer NOT NULL,
    category_id integer NOT NULL,
    key character varying(64) NOT NULL,
    label character varying(255) NOT NULL,
    type character varying(32) NOT NULL,
    options jsonb,
    is_required boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.product_attribute_defs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.product_attribute_defs_id_seq OWNED BY public.product_attribute_defs.id;

CREATE TABLE public.product_categories (
    id integer NOT NULL,
    code character varying(64) NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_by integer,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.product_categories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.product_categories_id_seq OWNED BY public.product_categories.id;

CREATE TABLE public.products (
    id integer NOT NULL,
    code character varying(64) NOT NULL,
    name character varying(255) NOT NULL,
    project_id integer,
    brand character varying(255),
    color character varying(32),
    tags text[] DEFAULT ARRAY[]::text[],
    is_featured boolean DEFAULT false NOT NULL,
    image_url text,
    category_id integer,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    description text,
    price bigint,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp(6) with time zone,
    deleted_by integer
);

CREATE SEQUENCE public.products_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.products_id_seq OWNED BY public.products.id;

CREATE TABLE public.projects (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    code character varying(100) NOT NULL,
    color character varying(50),
    is_active boolean DEFAULT true NOT NULL,
    created_by integer,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone NOT NULL
);

CREATE SEQUENCE public.projects_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.projects_id_seq OWNED BY public.projects.id;

CREATE TABLE public.rbac_audit_log (
    id bigint NOT NULL,
    actor_id integer NOT NULL,
    action text NOT NULL,
    target_type text NOT NULL,
    target_id integer NOT NULL,
    before jsonb,
    after jsonb,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.rbac_audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.rbac_audit_log_id_seq OWNED BY public.rbac_audit_log.id;

CREATE TABLE public.record_links (
    id integer NOT NULL,
    source_type character varying(16) NOT NULL,
    source_id integer NOT NULL,
    source_field character varying(48) NOT NULL,
    target_type character varying(16) NOT NULL,
    target_id integer NOT NULL,
    created_by integer,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.record_links_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.record_links_id_seq OWNED BY public.record_links.id;

CREATE TABLE public.recruitment_candidates (
    id integer NOT NULL,
    full_name text NOT NULL,
    phone character varying(20),
    email text,
    "position" text,
    department text,
    source text,
    stage text DEFAULT 'applied'::text NOT NULL,
    decision text DEFAULT 'pending'::text NOT NULL,
    recruitment_type text DEFAULT 'external'::text NOT NULL,
    applied_date date,
    cost integer,
    note text,
    gender text,
    interview_date date,
    interview_time character varying(5),
    recruiter_id integer,
    created_by integer,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL
);

CREATE SEQUENCE public.recruitment_candidates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.recruitment_candidates_id_seq OWNED BY public.recruitment_candidates.id;

CREATE TABLE public.recruitment_positions (
    id integer NOT NULL,
    job_code text NOT NULL,
    department text NOT NULL,
    team text,
    position_title text NOT NULL,
    headcount integer DEFAULT 1 NOT NULL,
    recruiter_id integer,
    opened_date date,
    expected_start_date date,
    description text,
    requirements text,
    recruitment_cost integer,
    status text DEFAULT 'open'::text NOT NULL,
    created_by integer,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL
);

CREATE SEQUENCE public.recruitment_positions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.recruitment_positions_id_seq OWNED BY public.recruitment_positions.id;

CREATE TABLE public.revoked_sessions (
    session_id character varying(64) NOT NULL,
    user_id integer NOT NULL,
    expires_at timestamp(3) with time zone NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.role_permissions (
    role_id integer NOT NULL,
    permission text NOT NULL,
    scope text
);

CREATE TABLE public.roles (
    id integer NOT NULL,
    name text NOT NULL,
    description text,
    is_system boolean DEFAULT false NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.roles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.roles_id_seq OWNED BY public.roles.id;

CREATE TABLE public.salary_components (
    id integer NOT NULL,
    name text NOT NULL,
    code text NOT NULL,
    component_type text NOT NULL,
    calc_method text DEFAULT 'fixed'::text NOT NULL,
    fixed_amount bigint DEFAULT 0,
    percent_value numeric(5,2),
    applies_to text DEFAULT 'all'::text NOT NULL,
    is_taxable boolean DEFAULT true NOT NULL,
    effective_from text NOT NULL,
    effective_to text,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    description text,
    created_by integer,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL
);

CREATE SEQUENCE public.salary_components_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.salary_components_id_seq OWNED BY public.salary_components.id;

CREATE TABLE public.salary_rule_details (
    id integer NOT NULL,
    salary_rule_id integer NOT NULL,
    component text NOT NULL,
    amount bigint,
    formula text,
    params jsonb,
    "order" integer DEFAULT 0 NOT NULL
);

CREATE SEQUENCE public.salary_rule_details_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.salary_rule_details_id_seq OWNED BY public.salary_rule_details.id;

CREATE TABLE public.salary_rules (
    id integer NOT NULL,
    "position" text NOT NULL,
    name text NOT NULL,
    description text
);

CREATE SEQUENCE public.salary_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.salary_rules_id_seq OWNED BY public.salary_rules.id;

CREATE TABLE public.setting_options (
    id integer NOT NULL,
    group_key text NOT NULL,
    value text NOT NULL,
    label text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    metadata jsonb,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(6) with time zone NOT NULL,
    updated_by integer
);

CREATE SEQUENCE public.setting_options_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.setting_options_id_seq OWNED BY public.setting_options.id;

CREATE TABLE public.settings (
    key text NOT NULL,
    value text NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL,
    updated_by integer
);

CREATE TABLE public.social_accounts (
    id integer NOT NULL,
    network character varying(16) NOT NULL,
    external_id character varying(64) NOT NULL,
    name character varying(200) NOT NULL,
    avatar_url text,
    access_token_enc text NOT NULL,
    refresh_token_enc text,
    token_expires_at timestamp(3) with time zone,
    scopes text DEFAULT ''::text NOT NULL,
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    last_error character varying(500),
    connected_by integer NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.social_accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.social_accounts_id_seq OWNED BY public.social_accounts.id;

CREATE TABLE public.social_drafts (
    id integer NOT NULL,
    title character varying(120),
    content text DEFAULT ''::text NOT NULL,
    media jsonb DEFAULT '[]'::jsonb NOT NULL,
    targets jsonb DEFAULT '[]'::jsonb NOT NULL,
    scheduled_at timestamp(3) with time zone,
    ui jsonb,
    post_id integer,
    publishing_at timestamp(3) with time zone,
    source character varying(80) DEFAULT 'web'::character varying NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    use_queue boolean DEFAULT false NOT NULL
);

CREATE SEQUENCE public.social_drafts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.social_drafts_id_seq OWNED BY public.social_drafts.id;

CREATE TABLE public.social_media_assets (
    id integer NOT NULL,
    key character varying(200) NOT NULL,
    type character varying(8) NOT NULL,
    content_type character varying(60) NOT NULL,
    size integer NOT NULL,
    name character varying(200) NOT NULL,
    source character varying(20) DEFAULT 'web'::character varying NOT NULL,
    uploaded_by integer NOT NULL,
    hidden_at timestamp(3) with time zone,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.social_media_assets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.social_media_assets_id_seq OWNED BY public.social_media_assets.id;

CREATE TABLE public.social_post_targets (
    id integer NOT NULL,
    post_id integer NOT NULL,
    account_id integer NOT NULL,
    network character varying(16) NOT NULL,
    caption text,
    options jsonb DEFAULT '{}'::jsonb NOT NULL,
    status character varying(16) DEFAULT 'queued'::character varying NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    claimed_at timestamp(3) with time zone,
    external_post_id character varying(120),
    url text,
    last_error character varying(500),
    published_at timestamp(3) with time zone,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    metrics jsonb,
    metrics_at timestamp(3) with time zone
);

CREATE SEQUENCE public.social_post_targets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.social_post_targets_id_seq OWNED BY public.social_post_targets.id;

CREATE TABLE public.social_posts (
    id integer NOT NULL,
    content text NOT NULL,
    media jsonb DEFAULT '[]'::jsonb NOT NULL,
    scheduled_at timestamp(3) with time zone,
    status character varying(16) DEFAULT 'scheduled'::character varying NOT NULL,
    source character varying(80) DEFAULT 'web'::character varying NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.social_posts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.social_posts_id_seq OWNED BY public.social_posts.id;

CREATE TABLE public.social_queue_slots (
    id integer NOT NULL,
    weekday integer NOT NULL,
    minute integer NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.social_queue_slots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.social_queue_slots_id_seq OWNED BY public.social_queue_slots.id;

CREATE TABLE public.social_recurrences (
    id integer NOT NULL,
    title character varying(120) NOT NULL,
    template jsonb NOT NULL,
    rule jsonb NOT NULL,
    starts_on date NOT NULL,
    ends_on date,
    max_count integer,
    count integer DEFAULT 0 NOT NULL,
    next_run_at timestamp(3) with time zone,
    active boolean DEFAULT true NOT NULL,
    last_error text,
    created_by integer NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.social_recurrences_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.social_recurrences_id_seq OWNED BY public.social_recurrences.id;

CREATE TABLE public.social_snippets (
    id integer NOT NULL,
    kind character varying(16) NOT NULL,
    name character varying(80) NOT NULL,
    content text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL
);

CREATE SEQUENCE public.social_snippets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.social_snippets_id_seq OWNED BY public.social_snippets.id;

CREATE TABLE public.store_orders (
    id integer NOT NULL,
    code character varying(20) NOT NULL,
    status character varying(16) DEFAULT 'new'::character varying NOT NULL,
    customer_name character varying(120) NOT NULL,
    customer_phone character varying(20) NOT NULL,
    customer_address character varying(300),
    note character varying(500),
    items jsonb DEFAULT '[]'::jsonb NOT NULL,
    total bigint NOT NULL,
    payment_method character varying(16) NOT NULL,
    payment_intent_id integer,
    contact_id integer,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.store_orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.store_orders_id_seq OWNED BY public.store_orders.id;

CREATE TABLE public.tax_brackets (
    id integer NOT NULL,
    bracket_order integer NOT NULL,
    lower_bound bigint NOT NULL,
    upper_bound bigint,
    rate numeric(5,2) NOT NULL,
    effective_from text NOT NULL,
    effective_to text,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL
);

CREATE SEQUENCE public.tax_brackets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.tax_brackets_id_seq OWNED BY public.tax_brackets.id;

CREATE TABLE public.teams (
    id integer NOT NULL,
    name text NOT NULL,
    description text,
    department text,
    team_lead_id integer,
    color character varying(20),
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.teams_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.teams_id_seq OWNED BY public.teams.id;

CREATE TABLE public.token_blacklist (
    user_id integer NOT NULL,
    expires_at timestamp(3) with time zone NOT NULL,
    updated_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.user_invitations (
    id integer NOT NULL,
    email character varying(255) NOT NULL,
    role_id integer,
    token_hash character varying(64) NOT NULL,
    expires_at timestamp(3) with time zone NOT NULL,
    accepted_at timestamp(3) with time zone,
    accepted_user_id integer,
    revoked_at timestamp(3) with time zone,
    created_by integer,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.user_invitations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.user_invitations_id_seq OWNED BY public.user_invitations.id;

CREATE TABLE public.user_roles (
    id integer NOT NULL,
    user_id integer NOT NULL,
    role_id integer NOT NULL
);

CREATE SEQUENCE public.user_roles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.user_roles_id_seq OWNED BY public.user_roles.id;

CREATE TABLE public.users (
    id integer NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    password_updated_at timestamp(3) with time zone,
    full_name text NOT NULL,
    phone text,
    avatar_url text,
    team_id integer,
    manager_id integer,
    status text DEFAULT 'active'::text NOT NULL,
    deleted_at timestamp(3) with time zone,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL,
    pinned_menu_keys text[] DEFAULT ARRAY[]::text[],
    tokens_valid_after timestamp(3) with time zone
);

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;

CREATE TABLE public.webhook_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    endpoint_id integer NOT NULL,
    event_id bigint,
    event_type character varying(64) NOT NULL,
    payload jsonb NOT NULL,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_status_code integer,
    last_error character varying(255),
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    delivered_at timestamp(3) with time zone
);

CREATE TABLE public.webhook_endpoints (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    url character varying(2048) NOT NULL,
    secret_enc text NOT NULL,
    events text[],
    is_active boolean DEFAULT true NOT NULL,
    disabled_reason character varying(64),
    created_by integer NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL,
    last_success_at timestamp(3) with time zone,
    last_failure_at timestamp(3) with time zone,
    consecutive_failures integer DEFAULT 0 NOT NULL
);

CREATE SEQUENCE public.webhook_endpoints_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.webhook_endpoints_id_seq OWNED BY public.webhook_endpoints.id;

CREATE TABLE public.webhook_inbound_receipts (
    id bigint NOT NULL,
    source_id integer NOT NULL,
    external_id character varying(128) NOT NULL,
    contact_id integer,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.webhook_inbound_receipts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.webhook_inbound_receipts_id_seq OWNED BY public.webhook_inbound_receipts.id;

CREATE TABLE public.webhook_inbound_sources (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    token_hash character varying(64) NOT NULL,
    token_prefix character varying(16) NOT NULL,
    signing_secret_enc text,
    default_assignee_id integer NOT NULL,
    contact_source_id integer NOT NULL,
    project_id integer,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL,
    last_received_at timestamp(3) with time zone
);

CREATE SEQUENCE public.webhook_inbound_sources_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.webhook_inbound_sources_id_seq OWNED BY public.webhook_inbound_sources.id;

CREATE TABLE public.zalo_oa_connections (
    id integer NOT NULL,
    oa_id character varying(64) NOT NULL,
    access_token_enc text NOT NULL,
    refresh_token_enc text NOT NULL,
    access_expires_at timestamp(3) with time zone NOT NULL,
    refresh_expires_at timestamp(3) with time zone,
    status character varying(16) DEFAULT 'active'::character varying NOT NULL,
    last_error character varying(300),
    last_refreshed_at timestamp(3) with time zone,
    connected_by integer NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL
);

CREATE SEQUENCE public.zalo_oa_connections_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.zalo_oa_connections_id_seq OWNED BY public.zalo_oa_connections.id;

CREATE TABLE public.zalo_oa_messages (
    id bigint NOT NULL,
    thread_id integer NOT NULL,
    direction character varying(3) NOT NULL,
    kind character varying(16) NOT NULL,
    msg_id character varying(64),
    text text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status character varying(12) NOT NULL,
    error character varying(300),
    sent_by integer,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE SEQUENCE public.zalo_oa_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.zalo_oa_messages_id_seq OWNED BY public.zalo_oa_messages.id;

CREATE TABLE public.zalo_oa_oauth_states (
    state character varying(64) NOT NULL,
    code_verifier_enc text NOT NULL,
    user_id integer NOT NULL,
    expires_at timestamp(3) with time zone NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.zalo_oa_threads (
    id integer NOT NULL,
    oa_id character varying(64) NOT NULL,
    zalo_user_id character varying(64) NOT NULL,
    display_name character varying(200),
    avatar_url character varying(500),
    phone character varying(20),
    contact_id integer,
    last_message_preview character varying(200),
    last_message_at timestamp(3) with time zone,
    last_inbound_at timestamp(3) with time zone,
    unread_count integer DEFAULT 0 NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL
);

CREATE SEQUENCE public.zalo_oa_threads_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.zalo_oa_threads_id_seq OWNED BY public.zalo_oa_threads.id;

ALTER TABLE ONLY platform.companies ALTER COLUMN id SET DEFAULT nextval('platform.companies_id_seq'::regclass);

ALTER TABLE ONLY public.activities ALTER COLUMN id SET DEFAULT nextval('public.activities_id_seq'::regclass);

ALTER TABLE ONLY public.ai_action_drafts ALTER COLUMN id SET DEFAULT nextval('public.ai_action_drafts_id_seq'::regclass);

ALTER TABLE ONLY public.api_keys ALTER COLUMN id SET DEFAULT nextval('public.api_keys_id_seq'::regclass);

ALTER TABLE ONLY public.attendance_offices ALTER COLUMN id SET DEFAULT nextval('public.attendance_offices_id_seq'::regclass);

ALTER TABLE ONLY public.attendance_qr_sessions ALTER COLUMN id SET DEFAULT nextval('public.attendance_qr_sessions_id_seq'::regclass);

ALTER TABLE ONLY public.attendance_records ALTER COLUMN id SET DEFAULT nextval('public.attendance_records_id_seq'::regclass);

ALTER TABLE ONLY public.attendance_requests ALTER COLUMN id SET DEFAULT nextval('public.attendance_requests_id_seq'::regclass);

ALTER TABLE ONLY public.audit_logs ALTER COLUMN id SET DEFAULT nextval('public.audit_logs_id_seq'::regclass);

ALTER TABLE ONLY public.briefings ALTER COLUMN id SET DEFAULT nextval('public.briefings_id_seq'::regclass);

ALTER TABLE ONLY public.channel_events ALTER COLUMN id SET DEFAULT nextval('public.channel_events_id_seq'::regclass);

ALTER TABLE ONLY public.connector_accounts ALTER COLUMN id SET DEFAULT nextval('public.connector_accounts_id_seq'::regclass);

ALTER TABLE ONLY public.connector_events ALTER COLUMN id SET DEFAULT nextval('public.connector_events_id_seq'::regclass);

ALTER TABLE ONLY public.connector_records ALTER COLUMN id SET DEFAULT nextval('public.connector_records_id_seq'::regclass);

ALTER TABLE ONLY public.contact_recent_views ALTER COLUMN id SET DEFAULT nextval('public.contact_recent_views_id_seq'::regclass);

ALTER TABLE ONLY public.contacts ALTER COLUMN id SET DEFAULT nextval('public.contacts_id_seq'::regclass);

ALTER TABLE ONLY public.contract_templates ALTER COLUMN id SET DEFAULT nextval('public.contract_templates_id_seq'::regclass);

ALTER TABLE ONLY public.custom_fields ALTER COLUMN id SET DEFAULT nextval('public.custom_fields_id_seq'::regclass);

ALTER TABLE ONLY public.custom_objects ALTER COLUMN id SET DEFAULT nextval('public.custom_objects_id_seq'::regclass);

ALTER TABLE ONLY public.custom_records ALTER COLUMN id SET DEFAULT nextval('public.custom_records_id_seq'::regclass);

ALTER TABLE ONLY public.custom_schema_versions ALTER COLUMN id SET DEFAULT nextval('public.custom_schema_versions_id_seq'::regclass);

ALTER TABLE ONLY public.custom_views ALTER COLUMN id SET DEFAULT nextval('public.custom_views_id_seq'::regclass);

ALTER TABLE ONLY public.deals ALTER COLUMN id SET DEFAULT nextval('public.deals_id_seq'::regclass);

ALTER TABLE ONLY public.employee_contracts ALTER COLUMN id SET DEFAULT nextval('public.employee_contracts_id_seq'::regclass);

ALTER TABLE ONLY public.employees ALTER COLUMN id SET DEFAULT nextval('public.employees_id_seq'::regclass);

ALTER TABLE ONLY public.employment_periods ALTER COLUMN id SET DEFAULT nextval('public.employment_periods_id_seq'::regclass);

ALTER TABLE ONLY public.extension_runs ALTER COLUMN id SET DEFAULT nextval('public.extension_runs_id_seq'::regclass);

ALTER TABLE ONLY public.extension_versions ALTER COLUMN id SET DEFAULT nextval('public.extension_versions_id_seq'::regclass);

ALTER TABLE ONLY public.extensions ALTER COLUMN id SET DEFAULT nextval('public.extensions_id_seq'::regclass);

ALTER TABLE ONLY public.facebook_broadcast_recipients ALTER COLUMN id SET DEFAULT nextval('public.facebook_broadcast_recipients_id_seq'::regclass);

ALTER TABLE ONLY public.facebook_broadcasts ALTER COLUMN id SET DEFAULT nextval('public.facebook_broadcasts_id_seq'::regclass);

ALTER TABLE ONLY public.facebook_chat_links ALTER COLUMN id SET DEFAULT nextval('public.facebook_chat_links_id_seq'::regclass);

ALTER TABLE ONLY public.facebook_comment_rules ALTER COLUMN id SET DEFAULT nextval('public.facebook_comment_rules_id_seq'::regclass);

ALTER TABLE ONLY public.facebook_comments ALTER COLUMN id SET DEFAULT nextval('public.facebook_comments_id_seq'::regclass);

ALTER TABLE ONLY public.facebook_conversations ALTER COLUMN id SET DEFAULT nextval('public.facebook_conversations_id_seq'::regclass);

ALTER TABLE ONLY public.facebook_flow_runs ALTER COLUMN id SET DEFAULT nextval('public.facebook_flow_runs_id_seq'::regclass);

ALTER TABLE ONLY public.facebook_flows ALTER COLUMN id SET DEFAULT nextval('public.facebook_flows_id_seq'::regclass);

ALTER TABLE ONLY public.facebook_lead_receipts ALTER COLUMN id SET DEFAULT nextval('public.facebook_lead_receipts_id_seq'::regclass);

ALTER TABLE ONLY public.facebook_messages ALTER COLUMN id SET DEFAULT nextval('public.facebook_messages_id_seq'::regclass);

ALTER TABLE ONLY public.facebook_pages ALTER COLUMN id SET DEFAULT nextval('public.facebook_pages_id_seq'::regclass);

ALTER TABLE ONLY public.google_connections ALTER COLUMN id SET DEFAULT nextval('public.google_connections_id_seq'::regclass);

ALTER TABLE ONLY public.google_sheet_sync_runs ALTER COLUMN id SET DEFAULT nextval('public.google_sheet_sync_runs_id_seq'::regclass);

ALTER TABLE ONLY public.google_sheet_syncs ALTER COLUMN id SET DEFAULT nextval('public.google_sheet_syncs_id_seq'::regclass);

ALTER TABLE ONLY public.insurance_settings ALTER COLUMN id SET DEFAULT nextval('public.insurance_settings_id_seq'::regclass);

ALTER TABLE ONLY public.integration_audit_logs ALTER COLUMN id SET DEFAULT nextval('public.integration_audit_logs_id_seq'::regclass);

ALTER TABLE ONLY public.integration_events ALTER COLUMN id SET DEFAULT nextval('public.integration_events_id_seq'::regclass);

ALTER TABLE ONLY public.job_titles ALTER COLUMN id SET DEFAULT nextval('public.job_titles_id_seq'::regclass);

ALTER TABLE ONLY public.kanban_boards ALTER COLUMN id SET DEFAULT nextval('public.kanban_boards_id_seq'::regclass);

ALTER TABLE ONLY public.kanban_card_activities ALTER COLUMN id SET DEFAULT nextval('public.kanban_card_activities_id_seq'::regclass);

ALTER TABLE ONLY public.kanban_card_assignees ALTER COLUMN id SET DEFAULT nextval('public.kanban_card_assignees_id_seq'::regclass);

ALTER TABLE ONLY public.kanban_card_attachments ALTER COLUMN id SET DEFAULT nextval('public.kanban_card_attachments_id_seq'::regclass);

ALTER TABLE ONLY public.kanban_cards ALTER COLUMN id SET DEFAULT nextval('public.kanban_cards_id_seq'::regclass);

ALTER TABLE ONLY public.kanban_checklist_items ALTER COLUMN id SET DEFAULT nextval('public.kanban_checklist_items_id_seq'::regclass);

ALTER TABLE ONLY public.kanban_columns ALTER COLUMN id SET DEFAULT nextval('public.kanban_columns_id_seq'::regclass);

ALTER TABLE ONLY public.kanban_field_defs ALTER COLUMN id SET DEFAULT nextval('public.kanban_field_defs_id_seq'::regclass);

ALTER TABLE ONLY public.kpi_configs ALTER COLUMN id SET DEFAULT nextval('public.kpi_configs_id_seq'::regclass);

ALTER TABLE ONLY public.kpi_results ALTER COLUMN id SET DEFAULT nextval('public.kpi_results_id_seq'::regclass);

ALTER TABLE ONLY public.login_wifi_check_targets ALTER COLUMN id SET DEFAULT nextval('public.login_wifi_check_targets_id_seq'::regclass);

ALTER TABLE ONLY public.newsfeed_post_comments ALTER COLUMN id SET DEFAULT nextval('public.newsfeed_post_comments_id_seq'::regclass);

ALTER TABLE ONLY public.newsfeed_post_images ALTER COLUMN id SET DEFAULT nextval('public.newsfeed_post_images_id_seq'::regclass);

ALTER TABLE ONLY public.newsfeed_post_likes ALTER COLUMN id SET DEFAULT nextval('public.newsfeed_post_likes_id_seq'::regclass);

ALTER TABLE ONLY public.newsfeed_posts ALTER COLUMN id SET DEFAULT nextval('public.newsfeed_posts_id_seq'::regclass);

ALTER TABLE ONLY public.notification_logs ALTER COLUMN id SET DEFAULT nextval('public.notification_logs_id_seq'::regclass);

ALTER TABLE ONLY public.notification_templates ALTER COLUMN id SET DEFAULT nextval('public.notification_templates_id_seq'::regclass);

ALTER TABLE ONLY public.oauth_authorization_codes ALTER COLUMN id SET DEFAULT nextval('public.oauth_authorization_codes_id_seq'::regclass);

ALTER TABLE ONLY public.oauth_clients ALTER COLUMN id SET DEFAULT nextval('public.oauth_clients_id_seq'::regclass);

ALTER TABLE ONLY public.oauth_tokens ALTER COLUMN id SET DEFAULT nextval('public.oauth_tokens_id_seq'::regclass);

ALTER TABLE ONLY public.payment_intents ALTER COLUMN id SET DEFAULT nextval('public.payment_intents_id_seq'::regclass);

ALTER TABLE ONLY public.payroll_tax_settings ALTER COLUMN id SET DEFAULT nextval('public.payroll_tax_settings_id_seq'::regclass);

ALTER TABLE ONLY public.payslips ALTER COLUMN id SET DEFAULT nextval('public.payslips_id_seq'::regclass);

ALTER TABLE ONLY public.pos_areas ALTER COLUMN id SET DEFAULT nextval('public.pos_areas_id_seq'::regclass);

ALTER TABLE ONLY public.pos_modifiers ALTER COLUMN id SET DEFAULT nextval('public.pos_modifiers_id_seq'::regclass);

ALTER TABLE ONLY public.pos_order_items ALTER COLUMN id SET DEFAULT nextval('public.pos_order_items_id_seq'::regclass);

ALTER TABLE ONLY public.pos_orders ALTER COLUMN id SET DEFAULT nextval('public.pos_orders_id_seq'::regclass);

ALTER TABLE ONLY public.pos_payments ALTER COLUMN id SET DEFAULT nextval('public.pos_payments_id_seq'::regclass);

ALTER TABLE ONLY public.pos_shifts ALTER COLUMN id SET DEFAULT nextval('public.pos_shifts_id_seq'::regclass);

ALTER TABLE ONLY public.pos_tables ALTER COLUMN id SET DEFAULT nextval('public.pos_tables_id_seq'::regclass);

ALTER TABLE ONLY public.product_attribute_defs ALTER COLUMN id SET DEFAULT nextval('public.product_attribute_defs_id_seq'::regclass);

ALTER TABLE ONLY public.product_categories ALTER COLUMN id SET DEFAULT nextval('public.product_categories_id_seq'::regclass);

ALTER TABLE ONLY public.products ALTER COLUMN id SET DEFAULT nextval('public.products_id_seq'::regclass);

ALTER TABLE ONLY public.projects ALTER COLUMN id SET DEFAULT nextval('public.projects_id_seq'::regclass);

ALTER TABLE ONLY public.rbac_audit_log ALTER COLUMN id SET DEFAULT nextval('public.rbac_audit_log_id_seq'::regclass);

ALTER TABLE ONLY public.record_links ALTER COLUMN id SET DEFAULT nextval('public.record_links_id_seq'::regclass);

ALTER TABLE ONLY public.recruitment_candidates ALTER COLUMN id SET DEFAULT nextval('public.recruitment_candidates_id_seq'::regclass);

ALTER TABLE ONLY public.recruitment_positions ALTER COLUMN id SET DEFAULT nextval('public.recruitment_positions_id_seq'::regclass);

ALTER TABLE ONLY public.roles ALTER COLUMN id SET DEFAULT nextval('public.roles_id_seq'::regclass);

ALTER TABLE ONLY public.salary_components ALTER COLUMN id SET DEFAULT nextval('public.salary_components_id_seq'::regclass);

ALTER TABLE ONLY public.salary_rule_details ALTER COLUMN id SET DEFAULT nextval('public.salary_rule_details_id_seq'::regclass);

ALTER TABLE ONLY public.salary_rules ALTER COLUMN id SET DEFAULT nextval('public.salary_rules_id_seq'::regclass);

ALTER TABLE ONLY public.setting_options ALTER COLUMN id SET DEFAULT nextval('public.setting_options_id_seq'::regclass);

ALTER TABLE ONLY public.social_accounts ALTER COLUMN id SET DEFAULT nextval('public.social_accounts_id_seq'::regclass);

ALTER TABLE ONLY public.social_drafts ALTER COLUMN id SET DEFAULT nextval('public.social_drafts_id_seq'::regclass);

ALTER TABLE ONLY public.social_media_assets ALTER COLUMN id SET DEFAULT nextval('public.social_media_assets_id_seq'::regclass);

ALTER TABLE ONLY public.social_post_targets ALTER COLUMN id SET DEFAULT nextval('public.social_post_targets_id_seq'::regclass);

ALTER TABLE ONLY public.social_posts ALTER COLUMN id SET DEFAULT nextval('public.social_posts_id_seq'::regclass);

ALTER TABLE ONLY public.social_queue_slots ALTER COLUMN id SET DEFAULT nextval('public.social_queue_slots_id_seq'::regclass);

ALTER TABLE ONLY public.social_recurrences ALTER COLUMN id SET DEFAULT nextval('public.social_recurrences_id_seq'::regclass);

ALTER TABLE ONLY public.social_snippets ALTER COLUMN id SET DEFAULT nextval('public.social_snippets_id_seq'::regclass);

ALTER TABLE ONLY public.store_orders ALTER COLUMN id SET DEFAULT nextval('public.store_orders_id_seq'::regclass);

ALTER TABLE ONLY public.tax_brackets ALTER COLUMN id SET DEFAULT nextval('public.tax_brackets_id_seq'::regclass);

ALTER TABLE ONLY public.teams ALTER COLUMN id SET DEFAULT nextval('public.teams_id_seq'::regclass);

ALTER TABLE ONLY public.user_invitations ALTER COLUMN id SET DEFAULT nextval('public.user_invitations_id_seq'::regclass);

ALTER TABLE ONLY public.user_roles ALTER COLUMN id SET DEFAULT nextval('public.user_roles_id_seq'::regclass);

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);

ALTER TABLE ONLY public.webhook_endpoints ALTER COLUMN id SET DEFAULT nextval('public.webhook_endpoints_id_seq'::regclass);

ALTER TABLE ONLY public.webhook_inbound_receipts ALTER COLUMN id SET DEFAULT nextval('public.webhook_inbound_receipts_id_seq'::regclass);

ALTER TABLE ONLY public.webhook_inbound_sources ALTER COLUMN id SET DEFAULT nextval('public.webhook_inbound_sources_id_seq'::regclass);

ALTER TABLE ONLY public.zalo_oa_connections ALTER COLUMN id SET DEFAULT nextval('public.zalo_oa_connections_id_seq'::regclass);

ALTER TABLE ONLY public.zalo_oa_messages ALTER COLUMN id SET DEFAULT nextval('public.zalo_oa_messages_id_seq'::regclass);

ALTER TABLE ONLY public.zalo_oa_threads ALTER COLUMN id SET DEFAULT nextval('public.zalo_oa_threads_id_seq'::regclass);

ALTER TABLE ONLY platform.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY platform.companies
    ADD CONSTRAINT companies_schema_name_key UNIQUE (schema_name);

ALTER TABLE ONLY platform.company_logins
    ADD CONSTRAINT company_logins_pkey PRIMARY KEY (email);

ALTER TABLE ONLY platform.company_routes
    ADD CONSTRAINT company_routes_pkey PRIMARY KEY (kind, external_id);

ALTER TABLE ONLY public.active_sessions
    ADD CONSTRAINT active_sessions_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.ai_action_drafts
    ADD CONSTRAINT ai_action_drafts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.attendance_offices
    ADD CONSTRAINT attendance_offices_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.attendance_qr_sessions
    ADD CONSTRAINT attendance_qr_sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.attendance_records
    ADD CONSTRAINT attendance_records_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.attendance_requests
    ADD CONSTRAINT attendance_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.briefings
    ADD CONSTRAINT briefings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.channel_events
    ADD CONSTRAINT channel_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.channel_usage
    ADD CONSTRAINT channel_usage_pkey PRIMARY KEY (kind, bucket);

ALTER TABLE ONLY public.connector_accounts
    ADD CONSTRAINT connector_accounts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.connector_events
    ADD CONSTRAINT connector_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.connector_records
    ADD CONSTRAINT connector_records_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.contact_recent_views
    ADD CONSTRAINT contact_recent_views_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.contract_templates
    ADD CONSTRAINT contract_templates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.custom_fields
    ADD CONSTRAINT custom_fields_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.custom_objects
    ADD CONSTRAINT custom_objects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.custom_records
    ADD CONSTRAINT custom_records_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.custom_schema_versions
    ADD CONSTRAINT custom_schema_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.custom_views
    ADD CONSTRAINT custom_views_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.employee_contracts
    ADD CONSTRAINT employee_contracts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.employment_periods
    ADD CONSTRAINT employment_periods_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.extension_runs
    ADD CONSTRAINT extension_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.extension_versions
    ADD CONSTRAINT extension_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.extensions
    ADD CONSTRAINT extensions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.facebook_broadcast_recipients
    ADD CONSTRAINT facebook_broadcast_recipients_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.facebook_broadcasts
    ADD CONSTRAINT facebook_broadcasts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.facebook_chat_links
    ADD CONSTRAINT facebook_chat_links_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.facebook_comment_rules
    ADD CONSTRAINT facebook_comment_rules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.facebook_comments
    ADD CONSTRAINT facebook_comments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.facebook_conversations
    ADD CONSTRAINT facebook_conversations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.facebook_flow_runs
    ADD CONSTRAINT facebook_flow_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.facebook_flows
    ADD CONSTRAINT facebook_flows_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.facebook_lead_receipts
    ADD CONSTRAINT facebook_lead_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.facebook_messages
    ADD CONSTRAINT facebook_messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.facebook_pages
    ADD CONSTRAINT facebook_pages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.google_connections
    ADD CONSTRAINT google_connections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.google_sheet_sync_runs
    ADD CONSTRAINT google_sheet_sync_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.google_sheet_syncs
    ADD CONSTRAINT google_sheet_syncs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.insurance_settings
    ADD CONSTRAINT insurance_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.integration_audit_logs
    ADD CONSTRAINT integration_audit_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.integration_events
    ADD CONSTRAINT integration_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.job_titles
    ADD CONSTRAINT job_titles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.kanban_boards
    ADD CONSTRAINT kanban_boards_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.kanban_card_activities
    ADD CONSTRAINT kanban_card_activities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.kanban_card_assignees
    ADD CONSTRAINT kanban_card_assignees_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.kanban_card_attachments
    ADD CONSTRAINT kanban_card_attachments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.kanban_cards
    ADD CONSTRAINT kanban_cards_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.kanban_checklist_items
    ADD CONSTRAINT kanban_checklist_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.kanban_columns
    ADD CONSTRAINT kanban_columns_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.kanban_field_defs
    ADD CONSTRAINT kanban_field_defs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.kpi_configs
    ADD CONSTRAINT kpi_configs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.kpi_results
    ADD CONSTRAINT kpi_results_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lead_ai_intents
    ADD CONSTRAINT lead_ai_intents_pkey PRIMARY KEY (contact_id);

ALTER TABLE ONLY public.login_wifi_check_targets
    ADD CONSTRAINT login_wifi_check_targets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.newsfeed_post_comments
    ADD CONSTRAINT newsfeed_post_comments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.newsfeed_post_images
    ADD CONSTRAINT newsfeed_post_images_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.newsfeed_post_likes
    ADD CONSTRAINT newsfeed_post_likes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.newsfeed_posts
    ADD CONSTRAINT newsfeed_posts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.notification_logs
    ADD CONSTRAINT notification_logs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.notification_templates
    ADD CONSTRAINT notification_templates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.oauth_authorization_codes
    ADD CONSTRAINT oauth_authorization_codes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.oauth_clients
    ADD CONSTRAINT oauth_clients_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.oauth_tokens
    ADD CONSTRAINT oauth_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.payment_intents
    ADD CONSTRAINT payment_intents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.payroll_tax_settings
    ADD CONSTRAINT payroll_tax_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.payslips
    ADD CONSTRAINT payslips_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pos_areas
    ADD CONSTRAINT pos_areas_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pos_modifiers
    ADD CONSTRAINT pos_modifiers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pos_order_items
    ADD CONSTRAINT pos_order_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pos_orders
    ADD CONSTRAINT pos_orders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pos_payments
    ADD CONSTRAINT pos_payments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pos_settings
    ADD CONSTRAINT pos_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pos_shifts
    ADD CONSTRAINT pos_shifts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.pos_tables
    ADD CONSTRAINT pos_tables_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.product_attribute_defs
    ADD CONSTRAINT product_attribute_defs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.product_categories
    ADD CONSTRAINT product_categories_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.rbac_audit_log
    ADD CONSTRAINT rbac_audit_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.record_links
    ADD CONSTRAINT record_links_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.recruitment_candidates
    ADD CONSTRAINT recruitment_candidates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.recruitment_positions
    ADD CONSTRAINT recruitment_positions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.revoked_sessions
    ADD CONSTRAINT revoked_sessions_pkey PRIMARY KEY (session_id);

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (role_id, permission);

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.salary_components
    ADD CONSTRAINT salary_components_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.salary_rule_details
    ADD CONSTRAINT salary_rule_details_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.salary_rules
    ADD CONSTRAINT salary_rules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.setting_options
    ADD CONSTRAINT setting_options_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (key);

ALTER TABLE ONLY public.social_accounts
    ADD CONSTRAINT social_accounts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.social_drafts
    ADD CONSTRAINT social_drafts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.social_media_assets
    ADD CONSTRAINT social_media_assets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.social_post_targets
    ADD CONSTRAINT social_post_targets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.social_posts
    ADD CONSTRAINT social_posts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.social_queue_slots
    ADD CONSTRAINT social_queue_slots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.social_recurrences
    ADD CONSTRAINT social_recurrences_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.social_snippets
    ADD CONSTRAINT social_snippets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.store_orders
    ADD CONSTRAINT store_orders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tax_brackets
    ADD CONSTRAINT tax_brackets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.token_blacklist
    ADD CONSTRAINT token_blacklist_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY public.user_invitations
    ADD CONSTRAINT user_invitations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.webhook_deliveries
    ADD CONSTRAINT webhook_deliveries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.webhook_endpoints
    ADD CONSTRAINT webhook_endpoints_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.webhook_inbound_receipts
    ADD CONSTRAINT webhook_inbound_receipts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.webhook_inbound_sources
    ADD CONSTRAINT webhook_inbound_sources_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.zalo_oa_connections
    ADD CONSTRAINT zalo_oa_connections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.zalo_oa_messages
    ADD CONSTRAINT zalo_oa_messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.zalo_oa_oauth_states
    ADD CONSTRAINT zalo_oa_oauth_states_pkey PRIMARY KEY (state);

ALTER TABLE ONLY public.zalo_oa_threads
    ADD CONSTRAINT zalo_oa_threads_pkey PRIMARY KEY (id);

CREATE INDEX company_logins_company_idx ON platform.company_logins USING btree (company_id);

CREATE INDEX activities_contact_id_created_at_idx ON public.activities USING btree (contact_id, created_at);

CREATE INDEX ai_action_drafts_status_exp_idx ON public.ai_action_drafts USING btree (status, expires_at);

CREATE INDEX ai_action_drafts_user_status_idx ON public.ai_action_drafts USING btree (user_id, status, created_at);

CREATE UNIQUE INDEX api_keys_key_hash_key ON public.api_keys USING btree (key_hash);

CREATE INDEX api_keys_owner_user_id_idx ON public.api_keys USING btree (owner_user_id);

CREATE UNIQUE INDEX api_keys_prefix_key ON public.api_keys USING btree (prefix);

CREATE INDEX api_keys_revoked_at_idx ON public.api_keys USING btree (revoked_at);

CREATE INDEX attendance_qr_sessions_is_active_expires_at_idx ON public.attendance_qr_sessions USING btree (is_active, expires_at);

CREATE UNIQUE INDEX attendance_qr_sessions_token_key ON public.attendance_qr_sessions USING btree (token);

CREATE INDEX attendance_records_user_id_work_date_idx ON public.attendance_records USING btree (user_id, work_date);

CREATE UNIQUE INDEX attendance_records_user_id_work_date_key ON public.attendance_records USING btree (user_id, work_date);

CREATE INDEX attendance_records_work_date_idx ON public.attendance_records USING btree (work_date);

CREATE INDEX attendance_requests_status_idx ON public.attendance_requests USING btree (status);

CREATE INDEX attendance_requests_user_id_work_date_idx ON public.attendance_requests USING btree (user_id, work_date DESC);

CREATE INDEX audit_logs_resource_created_at_idx ON public.audit_logs USING btree (resource, created_at);

CREATE INDEX audit_logs_user_id_created_at_idx ON public.audit_logs USING btree (user_id, created_at);

CREATE INDEX briefings_user_id_created_at_idx ON public.briefings USING btree (user_id, created_at DESC);

CREATE UNIQUE INDEX briefings_user_id_slot_day_key ON public.briefings USING btree (user_id, slot, day);

CREATE INDEX channel_events_created_idx ON public.channel_events USING btree (created_at);

CREATE INDEX channel_events_kind_id_idx ON public.channel_events USING btree (kind, id);

CREATE UNIQUE INDEX connector_accounts_provider_key ON public.connector_accounts USING btree (provider);

CREATE UNIQUE INDEX connector_events_provider_external_id_key ON public.connector_events USING btree (provider, external_id);

CREATE INDEX connector_events_status_created_at_idx ON public.connector_events USING btree (status, created_at);

CREATE INDEX connector_records_contact_id_idx ON public.connector_records USING btree (contact_id);

CREATE INDEX connector_records_kind_external_updated_at_idx ON public.connector_records USING btree (kind, external_updated_at);

CREATE UNIQUE INDEX connector_records_provider_account_kind_external_id_key ON public.connector_records USING btree (provider, account, kind, external_id);

CREATE UNIQUE INDEX contact_recent_views_user_id_contact_id_key ON public.contact_recent_views USING btree (user_id, contact_id);

CREATE INDEX contact_recent_views_user_id_viewed_at_idx ON public.contact_recent_views USING btree (user_id, viewed_at DESC);

CREATE INDEX contacts_birthday_idx ON public.contacts USING btree (birthday);

CREATE UNIQUE INDEX contacts_code_uq ON public.contacts USING btree (code varchar_pattern_ops);

CREATE INDEX contacts_contact_status_id_idx ON public.contacts USING btree (contact_status_id);

CREATE INDEX contacts_deleted_at_idx ON public.contacts USING btree (deleted_at);

CREATE INDEX contacts_phone_idx ON public.contacts USING btree (phone);

CREATE INDEX contacts_product_id_idx ON public.contacts USING btree (product_id);

CREATE INDEX contacts_project_id_idx ON public.contacts USING btree (project_id);

CREATE INDEX contacts_reminder_at_idx ON public.contacts USING btree (reminder_at);

CREATE INDEX contacts_source_id_idx ON public.contacts USING btree (source_id);

CREATE INDEX contacts_stage_id_idx ON public.contacts USING btree (stage_id);

CREATE INDEX contacts_team_id_idx ON public.contacts USING btree (team_id);

CREATE INDEX contract_templates_created_at_idx ON public.contract_templates USING btree (created_at DESC);

CREATE INDEX custom_fields_object_idx ON public.custom_fields USING btree (object_id, deleted_at, sort_order);

CREATE UNIQUE INDEX custom_fields_object_key_live_uq ON public.custom_fields USING btree (object_id, key) WHERE (deleted_at IS NULL);

CREATE UNIQUE INDEX custom_fields_one_title_uq ON public.custom_fields USING btree (object_id) WHERE (is_title AND (deleted_at IS NULL));

CREATE UNIQUE INDEX custom_objects_code_prefix_uq ON public.custom_objects USING btree (code_prefix) WHERE (code_prefix IS NOT NULL);

CREATE UNIQUE INDEX custom_objects_key_live_uq ON public.custom_objects USING btree (key) WHERE (deleted_at IS NULL);

CREATE INDEX custom_objects_nav_idx ON public.custom_objects USING btree (deleted_at, show_in_nav, nav_order);

CREATE UNIQUE INDEX custom_records_code_uq ON public.custom_records USING btree (code varchar_pattern_ops);

CREATE INDEX custom_records_creator_idx ON public.custom_records USING btree (object_id, created_by);

CREATE UNIQUE INDEX custom_records_object_code_seq_uq ON public.custom_records USING btree (object_id, code_seq);

CREATE INDEX custom_records_object_idx ON public.custom_records USING btree (object_id, deleted_at, id DESC);

CREATE INDEX custom_records_owner_idx ON public.custom_records USING btree (object_id, owner_id);

CREATE INDEX custom_records_title_lower_idx ON public.custom_records USING btree (lower((title)::text) varchar_pattern_ops) WHERE (deleted_at IS NULL);

CREATE INDEX custom_schema_versions_created_idx ON public.custom_schema_versions USING btree (created_at DESC);

CREATE INDEX custom_views_nav_idx ON public.custom_views USING btree (deleted_at, show_in_nav, nav_order);

CREATE INDEX custom_views_object_idx ON public.custom_views USING btree (object_id, deleted_at);

CREATE UNIQUE INDEX custom_views_object_key_live_uq ON public.custom_views USING btree (object_id, key) WHERE (deleted_at IS NULL);

CREATE INDEX deals_assigned_to_status_idx ON public.deals USING btree (assigned_to, status);

CREATE UNIQUE INDEX deals_code_uq ON public.deals USING btree (code varchar_pattern_ops);

CREATE INDEX deals_created_at_idx ON public.deals USING btree (created_at);

CREATE INDEX deals_created_by_idx ON public.deals USING btree (created_by);

CREATE INDEX deals_status_won_at_idx ON public.deals USING btree (status, won_at);

CREATE INDEX employee_contracts_employee_id_idx ON public.employee_contracts USING btree (employee_id);

CREATE INDEX employee_contracts_end_date_idx ON public.employee_contracts USING btree (end_date);

CREATE INDEX employees_deleted_at_idx ON public.employees USING btree (deleted_at);

CREATE INDEX employees_job_title_id_idx ON public.employees USING btree (job_title_id);

CREATE INDEX employees_office_id_idx ON public.employees USING btree (office_id);

CREATE UNIQUE INDEX employees_user_id_key ON public.employees USING btree (user_id);

CREATE INDEX employment_periods_employee_id_idx ON public.employment_periods USING btree (employee_id);

CREATE UNIQUE INDEX employment_periods_one_open_idx ON public.employment_periods USING btree (employee_id) WHERE (ended_on IS NULL);

CREATE INDEX extension_runs_ext_idx ON public.extension_runs USING btree (extension_id, id DESC);

CREATE UNIQUE INDEX extension_versions_ext_ver_uq ON public.extension_versions USING btree (extension_id, version);

CREATE UNIQUE INDEX extensions_key_live_uq ON public.extensions USING btree (key) WHERE (deleted_at IS NULL);

CREATE INDEX extensions_status_kind_idx ON public.extensions USING btree (status, kind);

CREATE INDEX facebook_broadcast_recipients_status_idx ON public.facebook_broadcast_recipients USING btree (broadcast_id, status);

CREATE UNIQUE INDEX facebook_broadcast_recipients_uniq ON public.facebook_broadcast_recipients USING btree (broadcast_id, conversation_id);

CREATE INDEX facebook_broadcasts_status_idx ON public.facebook_broadcasts USING btree (status, scheduled_at);

CREATE UNIQUE INDEX facebook_chat_links_code_key ON public.facebook_chat_links USING btree (code);

CREATE INDEX facebook_chat_links_page_idx ON public.facebook_chat_links USING btree (page_id);

CREATE UNIQUE INDEX facebook_comments_comment_id_key ON public.facebook_comments USING btree (comment_id);

CREATE INDEX facebook_comments_page_idx ON public.facebook_comments USING btree (page_id, created_at DESC);

CREATE INDEX facebook_comments_post_from_idx ON public.facebook_comments USING btree (post_id, from_id);

CREATE INDEX facebook_conversations_last_idx ON public.facebook_conversations USING btree (last_message_at DESC);

CREATE UNIQUE INDEX facebook_conversations_page_psid_uniq ON public.facebook_conversations USING btree (page_id, psid);

CREATE INDEX facebook_flow_runs_conv_idx ON public.facebook_flow_runs USING btree (conversation_id, status);

CREATE INDEX facebook_flow_runs_due_idx ON public.facebook_flow_runs USING btree (status, due_at);

CREATE INDEX facebook_flow_runs_flow_idx ON public.facebook_flow_runs USING btree (flow_id, started_at DESC);

CREATE INDEX facebook_flows_page_idx ON public.facebook_flows USING btree (page_id, is_active);

CREATE INDEX facebook_lead_receipts_created_idx ON public.facebook_lead_receipts USING btree (created_at);

CREATE UNIQUE INDEX facebook_lead_receipts_leadgen_id_key ON public.facebook_lead_receipts USING btree (leadgen_id);

CREATE INDEX facebook_messages_conv_idx ON public.facebook_messages USING btree (conversation_id, sent_at DESC);

CREATE UNIQUE INDEX facebook_messages_mid_key ON public.facebook_messages USING btree (mid);

CREATE UNIQUE INDEX facebook_pages_page_id_key ON public.facebook_pages USING btree (page_id);

CREATE INDEX google_connections_status_idx ON public.google_connections USING btree (status);

CREATE INDEX google_sheet_sync_runs_sync_idx ON public.google_sheet_sync_runs USING btree (sync_id, started_at DESC);

CREATE INDEX google_sheet_syncs_active_idx ON public.google_sheet_syncs USING btree (is_active, deleted_at);

CREATE INDEX idx_activities_action_created_at ON public.activities USING btree (action, created_at DESC);

CREATE INDEX idx_contacts_assigned_to_created_at_id ON public.contacts USING btree (assigned_to, created_at DESC, id DESC);

CREATE INDEX idx_contacts_created_at_id_desc ON public.contacts USING btree (created_at DESC, id DESC);

CREATE INDEX idx_contacts_created_by_id ON public.contacts USING btree (created_by_id);

CREATE INDEX insurance_settings_is_active_idx ON public.insurance_settings USING btree (is_active);

CREATE INDEX integration_audit_logs_channel_created_idx ON public.integration_audit_logs USING btree (channel, created_at DESC);

CREATE INDEX integration_audit_logs_created_idx ON public.integration_audit_logs USING btree (created_at DESC);

CREATE INDEX integration_audit_logs_user_created_idx ON public.integration_audit_logs USING btree (user_id, created_at DESC);

CREATE INDEX integration_events_created_idx ON public.integration_events USING btree (created_at);

CREATE INDEX integration_events_dispatch_idx ON public.integration_events USING btree (dispatched_at, id);

CREATE INDEX job_titles_category_idx ON public.job_titles USING btree (category);

CREATE INDEX job_titles_is_active_idx ON public.job_titles USING btree (is_active);

CREATE UNIQUE INDEX job_titles_rank_code_key ON public.job_titles USING btree (rank_code);

CREATE INDEX kanban_boards_is_active_deleted_at_idx ON public.kanban_boards USING btree (is_active, deleted_at);

CREATE INDEX kanban_card_activities_card_id_created_at_idx ON public.kanban_card_activities USING btree (card_id, created_at DESC);

CREATE UNIQUE INDEX kanban_card_assignees_card_id_user_id_key ON public.kanban_card_assignees USING btree (card_id, user_id);

CREATE INDEX kanban_card_assignees_user_id_idx ON public.kanban_card_assignees USING btree (user_id);

CREATE INDEX kanban_card_attachments_card_id_idx ON public.kanban_card_attachments USING btree (card_id);

CREATE INDEX kanban_cards_assignee_id_idx ON public.kanban_cards USING btree (assignee_id);

CREATE INDEX kanban_cards_board_id_column_id_position_idx ON public.kanban_cards USING btree (board_id, column_id, "position");

CREATE INDEX kanban_cards_board_id_deleted_at_idx ON public.kanban_cards USING btree (board_id, deleted_at);

CREATE UNIQUE INDEX kanban_cards_code_uq ON public.kanban_cards USING btree (code varchar_pattern_ops);

CREATE INDEX kanban_cards_contact_id_idx ON public.kanban_cards USING btree (contact_id);

CREATE INDEX kanban_cards_created_by_board_id_idx ON public.kanban_cards USING btree (created_by, board_id);

CREATE INDEX kanban_checklist_items_card_id_position_idx ON public.kanban_checklist_items USING btree (card_id, "position");

CREATE INDEX kanban_columns_board_id_is_archived_idx ON public.kanban_columns USING btree (board_id, is_archived);

CREATE INDEX kanban_columns_board_id_position_idx ON public.kanban_columns USING btree (board_id, "position");

CREATE UNIQUE INDEX kanban_field_defs_board_id_key_key ON public.kanban_field_defs USING btree (board_id, key);

CREATE INDEX kanban_field_defs_board_id_position_idx ON public.kanban_field_defs USING btree (board_id, "position");

CREATE UNIQUE INDEX kpi_results_employee_id_month_metric_name_key ON public.kpi_results USING btree (employee_id, month, metric_name);

CREATE UNIQUE INDEX login_wifi_check_targets_scope_type_target_user_id_key ON public.login_wifi_check_targets USING btree (scope_type, target_user_id);

CREATE INDEX login_wifi_check_targets_target_user_id_idx ON public.login_wifi_check_targets USING btree (target_user_id);

CREATE INDEX newsfeed_post_comments_post_id_id_idx ON public.newsfeed_post_comments USING btree (post_id, id);

CREATE INDEX newsfeed_post_images_post_id_sort_order_idx ON public.newsfeed_post_images USING btree (post_id, sort_order);

CREATE INDEX newsfeed_post_likes_post_id_idx ON public.newsfeed_post_likes USING btree (post_id);

CREATE UNIQUE INDEX newsfeed_post_likes_post_id_user_id_key ON public.newsfeed_post_likes USING btree (post_id, user_id);

CREATE INDEX newsfeed_posts_author_id_idx ON public.newsfeed_posts USING btree (author_id);

CREATE INDEX newsfeed_posts_category_id_idx ON public.newsfeed_posts USING btree (category, id DESC);

CREATE INDEX notification_logs_event_type_recipient_id_created_at_idx ON public.notification_logs USING btree (event_type, recipient_id, created_at);

CREATE INDEX notification_logs_recipient_id_created_at_idx ON public.notification_logs USING btree (recipient_id, created_at);

CREATE INDEX notification_logs_status_scheduled_at_idx ON public.notification_logs USING btree (status, scheduled_at);

CREATE UNIQUE INDEX notification_templates_name_key ON public.notification_templates USING btree (name);

CREATE UNIQUE INDEX oauth_authorization_codes_code_hash_key ON public.oauth_authorization_codes USING btree (code_hash);

CREATE UNIQUE INDEX oauth_clients_client_id_key ON public.oauth_clients USING btree (client_id);

CREATE INDEX oauth_clients_kind_created_idx ON public.oauth_clients USING btree (kind, created_at);

CREATE INDEX oauth_codes_expires_idx ON public.oauth_authorization_codes USING btree (expires_at);

CREATE UNIQUE INDEX oauth_tokens_access_hash_key ON public.oauth_tokens USING btree (access_hash);

CREATE INDEX oauth_tokens_family_idx ON public.oauth_tokens USING btree (family_id);

CREATE INDEX oauth_tokens_refresh_exp_idx ON public.oauth_tokens USING btree (refresh_expires_at);

CREATE UNIQUE INDEX oauth_tokens_refresh_hash_key ON public.oauth_tokens USING btree (refresh_hash);

CREATE INDEX oauth_tokens_user_revoked_idx ON public.oauth_tokens USING btree (user_id, revoked_at);

CREATE UNIQUE INDEX payment_intents_code_key ON public.payment_intents USING btree (code);

CREATE INDEX payment_intents_source_type_source_id_idx ON public.payment_intents USING btree (source_type, source_id);

CREATE INDEX payment_intents_status_created_at_idx ON public.payment_intents USING btree (status, created_at);

CREATE INDEX payroll_tax_settings_is_active_idx ON public.payroll_tax_settings USING btree (is_active);

CREATE UNIQUE INDEX payslips_employee_id_month_key ON public.payslips USING btree (employee_id, month);

CREATE INDEX payslips_month_deleted_at_idx ON public.payslips USING btree (month, deleted_at);

CREATE UNIQUE INDEX pos_areas_name_key ON public.pos_areas USING btree (name);

CREATE UNIQUE INDEX pos_modifiers_group_name_name_key ON public.pos_modifiers USING btree (group_name, name);

CREATE INDEX pos_order_items_order_id_idx ON public.pos_order_items USING btree (order_id);

CREATE INDEX pos_order_items_product_id_idx ON public.pos_order_items USING btree (product_id);

CREATE UNIQUE INDEX pos_orders_code_key ON public.pos_orders USING btree (code);

CREATE INDEX pos_orders_paid_at_idx ON public.pos_orders USING btree (paid_at);

CREATE INDEX pos_orders_shift_id_idx ON public.pos_orders USING btree (shift_id);

CREATE INDEX pos_orders_status_created_at_idx ON public.pos_orders USING btree (status, created_at);

CREATE INDEX pos_orders_table_id_status_idx ON public.pos_orders USING btree (table_id, status);

CREATE INDEX pos_payments_order_id_idx ON public.pos_payments USING btree (order_id);

CREATE INDEX pos_payments_shift_id_method_idx ON public.pos_payments USING btree (shift_id, method);

CREATE UNIQUE INDEX pos_shifts_one_open_per_user ON public.pos_shifts USING btree (opened_by) WHERE ((status)::text = 'open'::text);

CREATE INDEX pos_shifts_opened_at_idx ON public.pos_shifts USING btree (opened_at);

CREATE INDEX pos_shifts_opened_by_status_idx ON public.pos_shifts USING btree (opened_by, status);

CREATE UNIQUE INDEX pos_tables_area_id_name_key ON public.pos_tables USING btree (area_id, name);

CREATE UNIQUE INDEX product_attribute_defs_category_id_key_key ON public.product_attribute_defs USING btree (category_id, key);

CREATE INDEX product_attribute_defs_category_id_sort_order_idx ON public.product_attribute_defs USING btree (category_id, sort_order);

CREATE UNIQUE INDEX product_categories_code_key ON public.product_categories USING btree (code);

CREATE INDEX product_categories_is_active_sort_order_idx ON public.product_categories USING btree (is_active, sort_order);

CREATE INDEX products_category_id_idx ON public.products USING btree (category_id);

CREATE UNIQUE INDEX products_code_key ON public.products USING btree (code);

CREATE INDEX products_is_active_idx ON public.products USING btree (is_active);

CREATE INDEX products_project_id_idx ON public.products USING btree (project_id);

CREATE UNIQUE INDEX projects_code_key ON public.projects USING btree (code);

CREATE INDEX rbac_audit_log_created_idx ON public.rbac_audit_log USING btree (created_at);

CREATE INDEX rbac_audit_log_target_idx ON public.rbac_audit_log USING btree (target_type, target_id);

CREATE UNIQUE INDEX record_links_edge_uq ON public.record_links USING btree (source_type, source_id, source_field, target_type, target_id);

CREATE INDEX record_links_target_idx ON public.record_links USING btree (target_type, target_id);

CREATE INDEX recruitment_candidates_applied_date_idx ON public.recruitment_candidates USING btree (applied_date DESC);

CREATE INDEX recruitment_candidates_source_idx ON public.recruitment_candidates USING btree (source);

CREATE INDEX recruitment_candidates_stage_idx ON public.recruitment_candidates USING btree (stage);

CREATE INDEX recruitment_positions_department_idx ON public.recruitment_positions USING btree (department);

CREATE INDEX recruitment_positions_opened_date_idx ON public.recruitment_positions USING btree (opened_date DESC);

CREATE INDEX recruitment_positions_status_idx ON public.recruitment_positions USING btree (status);

CREATE INDEX revoked_sessions_expires_at_idx ON public.revoked_sessions USING btree (expires_at);

CREATE INDEX revoked_sessions_user_id_idx ON public.revoked_sessions USING btree (user_id);

CREATE UNIQUE INDEX roles_name_key ON public.roles USING btree (name);

CREATE UNIQUE INDEX salary_components_code_key ON public.salary_components USING btree (code);

CREATE INDEX salary_components_component_type_is_active_idx ON public.salary_components USING btree (component_type, is_active);

CREATE INDEX setting_options_group_key_is_active_idx ON public.setting_options USING btree (group_key, is_active);

CREATE INDEX setting_options_group_key_sort_order_idx ON public.setting_options USING btree (group_key, sort_order);

CREATE UNIQUE INDEX setting_options_group_key_value_key ON public.setting_options USING btree (group_key, value);

CREATE UNIQUE INDEX social_accounts_network_external_uniq ON public.social_accounts USING btree (network, external_id);

CREATE INDEX social_drafts_user_updated_idx ON public.social_drafts USING btree (created_by, updated_at DESC);

CREATE INDEX social_media_assets_created_idx ON public.social_media_assets USING btree (created_at DESC);

CREATE UNIQUE INDEX social_media_assets_key_key ON public.social_media_assets USING btree (key);

CREATE UNIQUE INDEX social_post_targets_post_account_uniq ON public.social_post_targets USING btree (post_id, account_id);

CREATE INDEX social_post_targets_status_next_idx ON public.social_post_targets USING btree (status, next_attempt_at);

CREATE INDEX social_posts_created_idx ON public.social_posts USING btree (created_at DESC);

CREATE INDEX social_posts_scheduled_idx ON public.social_posts USING btree (scheduled_at);

CREATE UNIQUE INDEX social_queue_slots_weekday_minute_key ON public.social_queue_slots USING btree (weekday, minute);

CREATE INDEX social_recurrences_active_next_idx ON public.social_recurrences USING btree (active, next_run_at);

CREATE INDEX social_snippets_kind_position_idx ON public.social_snippets USING btree (kind, "position");

CREATE UNIQUE INDEX store_orders_code_key ON public.store_orders USING btree (code);

CREATE INDEX store_orders_status_created_at_idx ON public.store_orders USING btree (status, created_at);

CREATE INDEX tax_brackets_is_active_bracket_order_idx ON public.tax_brackets USING btree (is_active, bracket_order);

CREATE UNIQUE INDEX teams_name_key ON public.teams USING btree (name);

CREATE INDEX token_blacklist_expires_at_idx ON public.token_blacklist USING btree (expires_at);

CREATE INDEX user_invitations_email_idx ON public.user_invitations USING btree (email);

CREATE UNIQUE INDEX user_invitations_one_open_idx ON public.user_invitations USING btree (lower((email)::text)) WHERE ((accepted_at IS NULL) AND (revoked_at IS NULL));

CREATE UNIQUE INDEX user_invitations_token_hash_key ON public.user_invitations USING btree (token_hash);

CREATE UNIQUE INDEX user_roles_user_id_role_id_key ON public.user_roles USING btree (user_id, role_id);

CREATE INDEX users_deleted_at_idx ON public.users USING btree (deleted_at);

CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email);

CREATE INDEX users_manager_id_idx ON public.users USING btree (manager_id);

CREATE INDEX users_team_id_status_idx ON public.users USING btree (team_id, status);

CREATE INDEX webhook_deliveries_endpoint_created_idx ON public.webhook_deliveries USING btree (endpoint_id, created_at DESC);

CREATE UNIQUE INDEX webhook_deliveries_endpoint_event_uniq ON public.webhook_deliveries USING btree (endpoint_id, event_id);

CREATE INDEX webhook_deliveries_status_next_idx ON public.webhook_deliveries USING btree (status, next_attempt_at);

CREATE INDEX webhook_endpoints_created_by_idx ON public.webhook_endpoints USING btree (created_by);

CREATE INDEX webhook_endpoints_is_active_idx ON public.webhook_endpoints USING btree (is_active);

CREATE INDEX webhook_inbound_receipts_created_idx ON public.webhook_inbound_receipts USING btree (created_at);

CREATE UNIQUE INDEX webhook_inbound_receipts_source_ext_uniq ON public.webhook_inbound_receipts USING btree (source_id, external_id);

CREATE INDEX webhook_inbound_sources_created_by_idx ON public.webhook_inbound_sources USING btree (created_by);

CREATE UNIQUE INDEX webhook_inbound_sources_token_hash_key ON public.webhook_inbound_sources USING btree (token_hash);

CREATE UNIQUE INDEX zalo_oa_connections_oa_id_key ON public.zalo_oa_connections USING btree (oa_id);

CREATE UNIQUE INDEX zalo_oa_messages_thread_id_msg_id_key ON public.zalo_oa_messages USING btree (thread_id, msg_id);

CREATE INDEX zalo_oa_messages_thread_idx ON public.zalo_oa_messages USING btree (thread_id, id DESC);

CREATE INDEX zalo_oa_oauth_states_expires_at_idx ON public.zalo_oa_oauth_states USING btree (expires_at);

CREATE INDEX zalo_oa_threads_contact_id_idx ON public.zalo_oa_threads USING btree (contact_id);

CREATE INDEX zalo_oa_threads_last_msg_idx ON public.zalo_oa_threads USING btree (last_message_at DESC);

CREATE UNIQUE INDEX zalo_oa_threads_oa_id_zalo_user_id_key ON public.zalo_oa_threads USING btree (oa_id, zalo_user_id);

CREATE TRIGGER trinity_contacts_code BEFORE INSERT ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.trinity_core_code('KH', 'contacts_code_seq');

CREATE TRIGGER trinity_custom_objects_code_prefix BEFORE INSERT ON public.custom_objects FOR EACH ROW EXECUTE FUNCTION public.trinity_custom_objects_code_prefix();

CREATE TRIGGER trinity_custom_records_code BEFORE INSERT ON public.custom_records FOR EACH ROW EXECUTE FUNCTION public.trinity_custom_records_code();

CREATE TRIGGER trinity_deals_code BEFORE INSERT ON public.deals FOR EACH ROW EXECUTE FUNCTION public.trinity_core_code('DL', 'deals_code_seq');

CREATE TRIGGER trinity_kanban_cards_code BEFORE INSERT ON public.kanban_cards FOR EACH ROW EXECUTE FUNCTION public.trinity_core_code('CV', 'kanban_cards_code_seq');

CREATE TRIGGER trinity_platform_sync_facebook_page AFTER INSERT OR DELETE OR UPDATE OF page_id ON public.facebook_pages FOR EACH ROW EXECUTE FUNCTION public.trinity_platform_sync_facebook_page();

CREATE TRIGGER trinity_platform_sync_login AFTER INSERT OR DELETE OR UPDATE OF email ON public.users FOR EACH ROW EXECUTE FUNCTION public.trinity_platform_sync_login();

CREATE TRIGGER trinity_platform_sync_zalo_oa AFTER INSERT OR DELETE OR UPDATE OF oa_id ON public.zalo_oa_connections FOR EACH ROW EXECUTE FUNCTION public.trinity_platform_sync_zalo_oa();

ALTER TABLE ONLY platform.company_logins
    ADD CONSTRAINT company_logins_company_id_fkey FOREIGN KEY (company_id) REFERENCES platform.companies(id);

ALTER TABLE ONLY platform.company_routes
    ADD CONSTRAINT company_routes_company_id_fkey FOREIGN KEY (company_id) REFERENCES platform.companies(id);

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.attendance_qr_sessions
    ADD CONSTRAINT attendance_qr_sessions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.attendance_records
    ADD CONSTRAINT attendance_records_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.attendance_records
    ADD CONSTRAINT attendance_records_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.attendance_requests
    ADD CONSTRAINT attendance_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.attendance_requests
    ADD CONSTRAINT attendance_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_contact_status_id_fkey FOREIGN KEY (contact_status_id) REFERENCES public.setting_options(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_created_by_id_fkey FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.setting_options(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_stage_id_fkey FOREIGN KEY (stage_id) REFERENCES public.setting_options(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.custom_fields
    ADD CONSTRAINT custom_fields_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.custom_objects(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.custom_records
    ADD CONSTRAINT custom_records_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.custom_objects(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.custom_views
    ADD CONSTRAINT custom_views_object_id_fkey FOREIGN KEY (object_id) REFERENCES public.custom_objects(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.employee_contracts
    ADD CONSTRAINT employee_contracts_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_job_title_id_fkey FOREIGN KEY (job_title_id) REFERENCES public.job_titles(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_office_id_fkey FOREIGN KEY (office_id) REFERENCES public.attendance_offices(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.employment_periods
    ADD CONSTRAINT employment_periods_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.extension_runs
    ADD CONSTRAINT extension_runs_extension_id_fkey FOREIGN KEY (extension_id) REFERENCES public.extensions(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.extension_versions
    ADD CONSTRAINT extension_versions_extension_id_fkey FOREIGN KEY (extension_id) REFERENCES public.extensions(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.google_sheet_sync_runs
    ADD CONSTRAINT google_sheet_sync_runs_sync_id_fkey FOREIGN KEY (sync_id) REFERENCES public.google_sheet_syncs(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.kanban_card_activities
    ADD CONSTRAINT kanban_card_activities_card_id_fkey FOREIGN KEY (card_id) REFERENCES public.kanban_cards(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.kanban_card_assignees
    ADD CONSTRAINT kanban_card_assignees_card_id_fkey FOREIGN KEY (card_id) REFERENCES public.kanban_cards(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.kanban_card_attachments
    ADD CONSTRAINT kanban_card_attachments_card_id_fkey FOREIGN KEY (card_id) REFERENCES public.kanban_cards(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.kanban_cards
    ADD CONSTRAINT kanban_cards_board_id_fkey FOREIGN KEY (board_id) REFERENCES public.kanban_boards(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.kanban_cards
    ADD CONSTRAINT kanban_cards_column_id_fkey FOREIGN KEY (column_id) REFERENCES public.kanban_columns(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.kanban_checklist_items
    ADD CONSTRAINT kanban_checklist_items_card_id_fkey FOREIGN KEY (card_id) REFERENCES public.kanban_cards(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.kanban_columns
    ADD CONSTRAINT kanban_columns_board_id_fkey FOREIGN KEY (board_id) REFERENCES public.kanban_boards(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.kanban_field_defs
    ADD CONSTRAINT kanban_field_defs_board_id_fkey FOREIGN KEY (board_id) REFERENCES public.kanban_boards(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.kpi_results
    ADD CONSTRAINT kpi_results_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.newsfeed_post_comments
    ADD CONSTRAINT newsfeed_post_comments_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.newsfeed_posts(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.newsfeed_post_comments
    ADD CONSTRAINT newsfeed_post_comments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.newsfeed_post_images
    ADD CONSTRAINT newsfeed_post_images_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.newsfeed_posts(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.newsfeed_post_likes
    ADD CONSTRAINT newsfeed_post_likes_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.newsfeed_posts(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.newsfeed_post_likes
    ADD CONSTRAINT newsfeed_post_likes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.newsfeed_posts
    ADD CONSTRAINT newsfeed_posts_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.notification_logs
    ADD CONSTRAINT notification_logs_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.payslips
    ADD CONSTRAINT payslips_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.pos_order_items
    ADD CONSTRAINT pos_order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.pos_orders(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.pos_orders
    ADD CONSTRAINT pos_orders_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES public.pos_shifts(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.pos_payments
    ADD CONSTRAINT pos_payments_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.pos_orders(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.pos_payments
    ADD CONSTRAINT pos_payments_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES public.pos_shifts(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.pos_tables
    ADD CONSTRAINT pos_tables_area_id_fkey FOREIGN KEY (area_id) REFERENCES public.pos_areas(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.product_attribute_defs
    ADD CONSTRAINT product_attribute_defs_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.product_categories(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.product_categories(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.salary_rule_details
    ADD CONSTRAINT salary_rule_details_salary_rule_id_fkey FOREIGN KEY (salary_rule_id) REFERENCES public.salary_rules(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.zalo_oa_messages
    ADD CONSTRAINT zalo_oa_messages_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.zalo_oa_threads(id) ON UPDATE CASCADE ON DELETE CASCADE;
