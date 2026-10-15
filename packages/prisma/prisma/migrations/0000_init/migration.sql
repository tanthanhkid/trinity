-- Baseline schema for Trinity (generated from schema.prisma) plus the parts Prisma cannot express:
-- sequences, functions, triggers, partial indexes and initial settings rows.


-- CreateEnum
CREATE TYPE "NewsfeedMediaType" AS ENUM ('image', 'video');

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "password_updated_at" TIMESTAMPTZ(3),
    "full_name" TEXT NOT NULL,
    "phone" TEXT,
    "avatar_url" TEXT,
    "team_id" INTEGER,
    "manager_id" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'active',
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "pinned_menu_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "role_id" INTEGER NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" INTEGER NOT NULL,
    "permission" TEXT NOT NULL,
    "scope" TEXT,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission")
);

-- CreateTable
CREATE TABLE "rbac_audit_log" (
    "id" BIGSERIAL NOT NULL,
    "actor_id" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" INTEGER NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rbac_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "department" TEXT,
    "team_lead_id" INTEGER,
    "color" VARCHAR(20),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_wifi_check_targets" (
    "id" SERIAL NOT NULL,
    "scope_type" VARCHAR(20) NOT NULL,
    "target_user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,

    CONSTRAINT "login_wifi_check_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(24),
    "phone" TEXT NOT NULL,
    "phone_2" TEXT,
    "zalo_account" TEXT,
    "full_name" TEXT,
    "source_id" INTEGER,
    "source_locked" BOOLEAN NOT NULL DEFAULT false,
    "stage_id" INTEGER,
    "contact_status_id" INTEGER,
    "reminder_at" TIMESTAMPTZ(3),
    "reminder_notes" TEXT,
    "birthday" TIMESTAMPTZ(3),
    "job_title" TEXT,
    "assigned_to" INTEGER,
    "team_id" INTEGER,
    "created_by_id" INTEGER,
    "gender" TEXT,
    "current_address" TEXT,
    "company_name" TEXT,
    "email" TEXT,
    "custom_fields" JSONB NOT NULL DEFAULT '[]',
    "project_id" INTEGER,
    "product_id" INTEGER,
    "avatar_url" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "lead_score" INTEGER,
    "lead_label" VARCHAR(8),
    "lead_score_reasons" JSONB,
    "lead_scored_at" TIMESTAMPTZ(3),

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_recent_views" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "contact_id" INTEGER NOT NULL,
    "viewed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_recent_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activities" (
    "id" SERIAL NOT NULL,
    "contact_id" INTEGER,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "metadata" JSONB,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deals" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(24),
    "title" TEXT NOT NULL,
    "description" TEXT,
    "value" BIGINT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "note" TEXT,
    "assigned_to" INTEGER NOT NULL,
    "created_by" INTEGER NOT NULL,
    "contact_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "code" VARCHAR(100) NOT NULL,
    "color" VARCHAR(50),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_titles" (
    "id" SERIAL NOT NULL,
    "category" TEXT NOT NULL,
    "rank_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "base_salary" BIGINT NOT NULL DEFAULT 0,
    "standard_target" BIGINT NOT NULL DEFAULT 0,
    "default_insurance_salary" BIGINT,
    "review_cycle_months" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "job_titles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "employee_code" VARCHAR(50),
    "position" TEXT NOT NULL,
    "department" TEXT,
    "gender" TEXT,
    "team_id" INTEGER,
    "salary_rule_id" INTEGER,
    "job_title_id" INTEGER,
    "insurance_salary" BIGINT,
    "dependents_count" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "resigned_at" TIMESTAMPTZ(3),
    "education_level" TEXT,
    "recruitment_source" TEXT,
    "deleted_at" TIMESTAMPTZ(3),
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "office_id" INTEGER,
    "registered_device_id" VARCHAR(255),
    "device_registered_at" TIMESTAMPTZ(3),
    "birth_date" TIMESTAMPTZ(3),
    "id_card_number" VARCHAR(20),
    "id_card_issued_date" TIMESTAMPTZ(3),
    "id_card_issued_place" TEXT,
    "permanent_address" TEXT,
    "current_address" TEXT,
    "bank_account_number" VARCHAR(30),
    "bank_name" TEXT,
    "bank_account_holder" TEXT,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_contracts" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "contract_type" TEXT NOT NULL DEFAULT 'co_thoi_han',
    "signed_date" TIMESTAMPTZ(3) NOT NULL,
    "end_date" TIMESTAMPTZ(3),
    "file_url" TEXT,
    "notes" TEXT,
    "is_terminated" BOOLEAN NOT NULL DEFAULT false,
    "terminated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "employee_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_templates" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploaded_by" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment_candidates" (
    "id" SERIAL NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" VARCHAR(20),
    "email" TEXT,
    "position" TEXT,
    "department" TEXT,
    "source" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'applied',
    "decision" TEXT NOT NULL DEFAULT 'pending',
    "recruitment_type" TEXT NOT NULL DEFAULT 'external',
    "applied_date" DATE,
    "cost" INTEGER,
    "note" TEXT,
    "gender" TEXT,
    "interview_date" DATE,
    "interview_time" VARCHAR(5),
    "recruiter_id" INTEGER,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recruitment_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment_positions" (
    "id" SERIAL NOT NULL,
    "job_code" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "team" TEXT,
    "position_title" TEXT NOT NULL,
    "headcount" INTEGER NOT NULL DEFAULT 1,
    "recruiter_id" INTEGER,
    "opened_date" DATE,
    "expected_start_date" DATE,
    "description" TEXT,
    "requirements" TEXT,
    "recruitment_cost" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recruitment_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_rules" (
    "id" SERIAL NOT NULL,
    "position" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "salary_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_rule_details" (
    "id" SERIAL NOT NULL,
    "salary_rule_id" INTEGER NOT NULL,
    "component" TEXT NOT NULL,
    "amount" BIGINT,
    "formula" TEXT,
    "params" JSONB,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "salary_rule_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_components" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "component_type" TEXT NOT NULL,
    "calc_method" TEXT NOT NULL DEFAULT 'fixed',
    "fixed_amount" BIGINT DEFAULT 0,
    "percent_value" DECIMAL(5,2),
    "applies_to" TEXT NOT NULL DEFAULT 'all',
    "is_taxable" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" TEXT NOT NULL,
    "effective_to" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "description" TEXT,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "salary_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_settings" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "employee_rate" DECIMAL(5,2) NOT NULL,
    "base_cap" BIGINT,
    "effective_from" TEXT NOT NULL,
    "effective_to" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "insurance_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_brackets" (
    "id" SERIAL NOT NULL,
    "bracket_order" INTEGER NOT NULL,
    "lower_bound" BIGINT NOT NULL,
    "upper_bound" BIGINT,
    "rate" DECIMAL(5,2) NOT NULL,
    "effective_from" TEXT NOT NULL,
    "effective_to" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tax_brackets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_tax_settings" (
    "id" SERIAL NOT NULL,
    "personal_deduction" BIGINT NOT NULL,
    "dependent_deduction" BIGINT NOT NULL,
    "effective_from" TEXT NOT NULL,
    "effective_to" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payroll_tax_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kpi_configs" (
    "id" SERIAL NOT NULL,
    "role" TEXT NOT NULL,
    "metric_name" TEXT NOT NULL,
    "target" DECIMAL(15,2) NOT NULL,
    "unit" TEXT,
    "weight" DECIMAL(5,2),
    "working_days_per_month" INTEGER NOT NULL DEFAULT 24,

    CONSTRAINT "kpi_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kpi_results" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "month" TEXT NOT NULL,
    "metric_name" TEXT NOT NULL,
    "actual_value" DECIMAL(15,2) NOT NULL,
    "target_value" DECIMAL(15,2) NOT NULL,
    "achievement_rate" DECIMAL(5,2),
    "achieved" BOOLEAN NOT NULL DEFAULT false,
    "is_locked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kpi_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payslips" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "month" TEXT NOT NULL,
    "base_salary" BIGINT NOT NULL DEFAULT 0,
    "kpi_bonus" BIGINT NOT NULL DEFAULT 0,
    "deductions" BIGINT NOT NULL DEFAULT 0,
    "total" BIGINT NOT NULL DEFAULT 0,
    "components_json" JSONB,
    "insurance_json" JSONB,
    "insurance_base" BIGINT NOT NULL DEFAULT 0,
    "tax_json" JSONB,
    "working_days" DECIMAL(5,1),
    "standard_working_days" INTEGER NOT NULL DEFAULT 24,
    "base_salary_actual" BIGINT NOT NULL DEFAULT 0,
    "training_salary" BIGINT NOT NULL DEFAULT 0,
    "probation_allowance" BIGINT NOT NULL DEFAULT 0,
    "sales_personal" BIGINT NOT NULL DEFAULT 0,
    "bonus_rate" DECIMAL(7,4),
    "kpi_percent" DECIMAL(5,2),
    "bonus_sales_personal" BIGINT NOT NULL DEFAULT 0,
    "sales_team" BIGINT NOT NULL DEFAULT 0,
    "bonus_cskh_team" BIGINT NOT NULL DEFAULT 0,
    "bonus_milestone" BIGINT NOT NULL DEFAULT 0,
    "bonus_referral" BIGINT NOT NULL DEFAULT 0,
    "holiday_bonus" BIGINT NOT NULL DEFAULT 0,
    "advances" BIGINT NOT NULL DEFAULT 0,
    "training_days" DECIMAL(5,1),
    "personal_income_tax" BIGINT NOT NULL DEFAULT 0,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "tl_approved_by" INTEGER,
    "tl_approved_at" TIMESTAMPTZ(3),
    "approved_by" INTEGER,
    "approved_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "deleted_by" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payslips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "event_type" TEXT,
    "channel" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "recipients_rule" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_logs" (
    "id" SERIAL NOT NULL,
    "recipient_id" INTEGER NOT NULL,
    "template_id" INTEGER,
    "event_type" TEXT,
    "channel" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMPTZ(3),
    "error" TEXT,
    "scheduled_at" TIMESTAMPTZ(3),
    "action_url" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" INTEGER,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "lead_ai_intents" (
    "contact_id" INTEGER NOT NULL,
    "intent" DOUBLE PRECISION NOT NULL,
    "reason" VARCHAR(300),
    "client_id" VARCHAR(120),
    "user_id" INTEGER,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_ai_intents_pkey" PRIMARY KEY ("contact_id")
);

-- CreateTable
CREATE TABLE "setting_options" (
    "id" SERIAL NOT NULL,
    "group_key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" INTEGER,

    CONSTRAINT "setting_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "resource_id" INTEGER,
    "metadata" JSONB,
    "ip_address" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "prefix" VARCHAR(32) NOT NULL,
    "key_hash" VARCHAR(128) NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "owner_user_id" INTEGER NOT NULL,
    "created_by" INTEGER NOT NULL,
    "last_used_at" TIMESTAMPTZ(3),
    "last_used_ip" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "newsfeed_posts" (
    "id" SERIAL NOT NULL,
    "category" TEXT NOT NULL,
    "author_id" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "image_url" TEXT,
    "edited_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "newsfeed_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "newsfeed_post_images" (
    "id" SERIAL NOT NULL,
    "post_id" INTEGER NOT NULL,
    "image_url" TEXT NOT NULL,
    "media_type" "NewsfeedMediaType" NOT NULL DEFAULT 'image',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "newsfeed_post_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "newsfeed_post_likes" (
    "id" SERIAL NOT NULL,
    "post_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "newsfeed_post_likes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "newsfeed_post_comments" (
    "id" SERIAL NOT NULL,
    "post_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "newsfeed_post_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_offices" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "ips" TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_demo" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "attendance_offices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_qr_sessions" (
    "id" SERIAL NOT NULL,
    "token" TEXT NOT NULL,
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "attendance_qr_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_records" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "employee_id" INTEGER,
    "work_date" DATE NOT NULL,
    "check_in_at" TIMESTAMPTZ(3),
    "check_out_at" TIMESTAMPTZ(3),
    "check_in_proof_key" TEXT,
    "check_out_proof_key" TEXT,
    "check_in_lat" DOUBLE PRECISION,
    "check_in_lng" DOUBLE PRECISION,
    "check_out_lat" DOUBLE PRECISION,
    "check_out_lng" DOUBLE PRECISION,
    "check_in_note" TEXT,
    "check_out_note" TEXT,
    "total_hours" DOUBLE PRECISION,
    "overtime_hours" DOUBLE PRECISION,
    "late_minutes" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'incomplete',
    "check_in_ip" TEXT,
    "check_out_ip" TEXT,
    "check_in_office_id" INTEGER,
    "check_out_office_id" INTEGER,
    "device_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "attendance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_requests" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "work_date" DATE NOT NULL,
    "type" TEXT NOT NULL,
    "requested_check_in" TEXT,
    "requested_check_out" TEXT,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewed_by" INTEGER,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "attendance_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "project_id" INTEGER,
    "brand" VARCHAR(255),
    "color" VARCHAR(32),
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_featured" BOOLEAN NOT NULL DEFAULT false,
    "image_url" TEXT,
    "category_id" INTEGER,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "description" TEXT,
    "price" BIGINT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_categories" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_attribute_defs" (
    "id" SERIAL NOT NULL,
    "category_id" INTEGER NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "label" VARCHAR(255) NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "options" JSONB,
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_attribute_defs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kanban_boards" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "icon" VARCHAR(64),
    "color" VARCHAR(32),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "visibility_role_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "card_prefix" VARCHAR(16),
    "settings" JSONB NOT NULL DEFAULT '{}',
    "label_defs" JSONB NOT NULL DEFAULT '[]',
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "kanban_boards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kanban_columns" (
    "id" SERIAL NOT NULL,
    "board_id" INTEGER NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "color" VARCHAR(32),
    "position" DOUBLE PRECISION NOT NULL,
    "wip_limit" INTEGER,
    "is_done" BOOLEAN NOT NULL DEFAULT false,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kanban_columns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kanban_field_defs" (
    "id" SERIAL NOT NULL,
    "board_id" INTEGER NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "label" VARCHAR(255) NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "options" JSONB,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "show_on_card" BOOLEAN NOT NULL DEFAULT false,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kanban_field_defs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kanban_cards" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(24),
    "board_id" INTEGER NOT NULL,
    "column_id" INTEGER NOT NULL,
    "position" DOUBLE PRECISION NOT NULL,
    "title" VARCHAR(500) NOT NULL,
    "description" TEXT,
    "contact_id" INTEGER,
    "assignee_id" INTEGER,
    "created_by" INTEGER NOT NULL,
    "due_at" TIMESTAMPTZ(6),
    "priority" VARCHAR(16),
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "completed_at" TIMESTAMPTZ(6),
    "due_completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "kanban_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kanban_card_assignees" (
    "id" SERIAL NOT NULL,
    "card_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kanban_card_assignees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kanban_checklist_items" (
    "id" SERIAL NOT NULL,
    "card_id" INTEGER NOT NULL,
    "text" VARCHAR(500) NOT NULL,
    "is_done" BOOLEAN NOT NULL DEFAULT false,
    "position" DOUBLE PRECISION NOT NULL,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kanban_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kanban_card_attachments" (
    "id" SERIAL NOT NULL,
    "card_id" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "title" VARCHAR(255),
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kanban_card_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kanban_card_activities" (
    "id" SERIAL NOT NULL,
    "card_id" INTEGER NOT NULL,
    "actor_id" INTEGER,
    "action" VARCHAR(32) NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kanban_card_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "store_name" VARCHAR(255) NOT NULL DEFAULT 'Quán của tôi',
    "address" VARCHAR(500),
    "phone" VARCHAR(32),
    "receipt_footer" VARCHAR(500),
    "bank_bin" VARCHAR(8),
    "bank_account_no" VARCHAR(32),
    "bank_account_name" VARCHAR(255),
    "menu_category_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_areas" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_tables" (
    "id" SERIAL NOT NULL,
    "area_id" INTEGER NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_modifiers" (
    "id" SERIAL NOT NULL,
    "group_name" VARCHAR(100) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "price_delta" BIGINT NOT NULL DEFAULT 0,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_modifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_shifts" (
    "id" SERIAL NOT NULL,
    "opened_by" INTEGER NOT NULL,
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opening_cash" BIGINT NOT NULL DEFAULT 0,
    "status" VARCHAR(16) NOT NULL DEFAULT 'open',
    "closed_by" INTEGER,
    "closed_at" TIMESTAMPTZ(6),
    "closing_cash_counted" BIGINT,
    "expected_cash" BIGINT,
    "cash_diff" BIGINT,
    "note" VARCHAR(500),

    CONSTRAINT "pos_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_orders" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "shift_id" INTEGER NOT NULL,
    "table_id" INTEGER,
    "order_type" VARCHAR(16) NOT NULL DEFAULT 'dine_in',
    "status" VARCHAR(16) NOT NULL DEFAULT 'open',
    "note" VARCHAR(500),
    "subtotal" BIGINT NOT NULL DEFAULT 0,
    "discount_type" VARCHAR(16) NOT NULL DEFAULT 'none',
    "discount_value" BIGINT NOT NULL DEFAULT 0,
    "discount_amount" BIGINT NOT NULL DEFAULT 0,
    "total" BIGINT NOT NULL DEFAULT 0,
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_by" INTEGER,
    "paid_at" TIMESTAMPTZ(6),
    "voided_by" INTEGER,
    "voided_at" TIMESTAMPTZ(6),
    "void_reason" VARCHAR(500),

    CONSTRAINT "pos_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_order_items" (
    "id" SERIAL NOT NULL,
    "order_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "product_name" VARCHAR(255) NOT NULL,
    "unit_price" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "options" JSONB NOT NULL DEFAULT '[]',
    "note" VARCHAR(255),
    "line_total" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pos_payments" (
    "id" SERIAL NOT NULL,
    "order_id" INTEGER NOT NULL,
    "shift_id" INTEGER NOT NULL,
    "method" VARCHAR(16) NOT NULL,
    "amount" BIGINT NOT NULL,
    "tendered" BIGINT,
    "change" BIGINT NOT NULL DEFAULT 0,
    "reference" VARCHAR(100),
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pos_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "channel" VARCHAR(16) NOT NULL,
    "client_id" VARCHAR(255),
    "user_id" INTEGER,
    "action" VARCHAR(128) NOT NULL,
    "resource" VARCHAR(64),
    "resource_id" VARCHAR(64),
    "status" VARCHAR(16) NOT NULL,
    "http_status" INTEGER,
    "duration_ms" INTEGER,
    "error" VARCHAR(500),
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "integration_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_events" (
    "id" BIGSERIAL NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "resource" VARCHAR(32) NOT NULL,
    "resource_id" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "actor_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatched_at" TIMESTAMPTZ(3),

    CONSTRAINT "integration_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "secret_enc" TEXT NOT NULL,
    "events" TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "disabled_reason" VARCHAR(64),
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "last_success_at" TIMESTAMPTZ(3),
    "last_failure_at" TIMESTAMPTZ(3),
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "endpoint_id" INTEGER NOT NULL,
    "event_id" BIGINT,
    "event_type" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_status_code" INTEGER,
    "last_error" VARCHAR(255),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_inbound_sources" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "token_prefix" VARCHAR(16) NOT NULL,
    "signing_secret_enc" TEXT,
    "default_assignee_id" INTEGER NOT NULL,
    "contact_source_id" INTEGER NOT NULL,
    "project_id" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "last_received_at" TIMESTAMPTZ(3),

    CONSTRAINT "webhook_inbound_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_inbound_receipts" (
    "id" BIGSERIAL NOT NULL,
    "source_id" INTEGER NOT NULL,
    "external_id" VARCHAR(128) NOT NULL,
    "contact_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_inbound_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_clients" (
    "id" SERIAL NOT NULL,
    "client_id" VARCHAR(512) NOT NULL,
    "kind" VARCHAR(8) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "redirect_uris" TEXT[],
    "logo_uri" VARCHAR(1024),
    "client_uri" VARCHAR(1024),
    "token_endpoint_auth_method" VARCHAR(32) NOT NULL DEFAULT 'none',
    "client_secret_hash" VARCHAR(64),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "metadata_fetched_at" TIMESTAMPTZ(3),
    "metadata_expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),

    CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_authorization_codes" (
    "id" BIGSERIAL NOT NULL,
    "code_hash" VARCHAR(64) NOT NULL,
    "client_id" VARCHAR(512) NOT NULL,
    "user_id" INTEGER NOT NULL,
    "redirect_uri" VARCHAR(2048) NOT NULL,
    "code_challenge" VARCHAR(128) NOT NULL,
    "scopes" TEXT[],
    "resource" VARCHAR(512) NOT NULL,
    "family_id" VARCHAR(36) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_authorization_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_tokens" (
    "id" BIGSERIAL NOT NULL,
    "access_hash" VARCHAR(64) NOT NULL,
    "refresh_hash" VARCHAR(64) NOT NULL,
    "client_id" VARCHAR(512) NOT NULL,
    "user_id" INTEGER NOT NULL,
    "scopes" TEXT[],
    "resource" VARCHAR(512) NOT NULL,
    "family_id" VARCHAR(36) NOT NULL,
    "access_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "refresh_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "refresh_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),

    CONSTRAINT "oauth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_action_drafts" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "client_id" VARCHAR(512) NOT NULL,
    "tool" VARCHAR(64) NOT NULL,
    "params" JSONB NOT NULL,
    "summary" VARCHAR(1000) NOT NULL,
    "details" JSONB NOT NULL DEFAULT '[]',
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "result" JSONB,
    "error" VARCHAR(1000),
    "impact" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ai_action_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_objects" (
    "id" SERIAL NOT NULL,
    "key" VARCHAR(48) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "label_plural" VARCHAR(100) NOT NULL,
    "icon" VARCHAR(48),
    "description" VARCHAR(500),
    "show_in_nav" BOOLEAN NOT NULL DEFAULT true,
    "nav_order" INTEGER NOT NULL DEFAULT 0,
    "visible_role_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "code_prefix" VARCHAR(8),
    "code_prefix_aliases" VARCHAR(8)[] DEFAULT ARRAY[]::VARCHAR(8)[],
    "next_code_seq" INTEGER,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "custom_objects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_fields" (
    "id" SERIAL NOT NULL,
    "object_id" INTEGER NOT NULL,
    "key" VARCHAR(48) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "type" VARCHAR(16) NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "is_unique" BOOLEAN NOT NULL DEFAULT false,
    "is_title" BOOLEAN NOT NULL DEFAULT false,
    "show_in_list" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "options" JSONB NOT NULL DEFAULT '{}',
    "help_text" VARCHAR(300),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "custom_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_records" (
    "id" SERIAL NOT NULL,
    "object_id" INTEGER NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "title" VARCHAR(200),
    "code" VARCHAR(24),
    "code_seq" INTEGER,
    "owner_id" INTEGER,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "custom_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_views" (
    "id" SERIAL NOT NULL,
    "object_id" INTEGER NOT NULL,
    "key" VARCHAR(48) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "type" VARCHAR(16) NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "icon" VARCHAR(48),
    "show_in_nav" BOOLEAN NOT NULL DEFAULT false,
    "nav_order" INTEGER NOT NULL DEFAULT 0,
    "visible_role_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "custom_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "record_links" (
    "id" SERIAL NOT NULL,
    "source_type" VARCHAR(16) NOT NULL,
    "source_id" INTEGER NOT NULL,
    "source_field" VARCHAR(48) NOT NULL,
    "target_type" VARCHAR(16) NOT NULL,
    "target_id" INTEGER NOT NULL,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "record_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_schema_versions" (
    "id" SERIAL NOT NULL,
    "draft_id" INTEGER,
    "tool" VARCHAR(64) NOT NULL,
    "summary" VARCHAR(1000) NOT NULL,
    "snapshot" JSONB NOT NULL,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_schema_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zalo_oa_connections" (
    "id" SERIAL NOT NULL,
    "oa_id" VARCHAR(64) NOT NULL,
    "access_token_enc" TEXT NOT NULL,
    "refresh_token_enc" TEXT NOT NULL,
    "access_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "refresh_expires_at" TIMESTAMPTZ(3),
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "last_error" VARCHAR(300),
    "last_refreshed_at" TIMESTAMPTZ(3),
    "connected_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "zalo_oa_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zalo_oa_oauth_states" (
    "state" VARCHAR(64) NOT NULL,
    "code_verifier_enc" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zalo_oa_oauth_states_pkey" PRIMARY KEY ("state")
);

-- CreateTable
CREATE TABLE "zalo_oa_threads" (
    "id" SERIAL NOT NULL,
    "oa_id" VARCHAR(64) NOT NULL,
    "zalo_user_id" VARCHAR(64) NOT NULL,
    "display_name" VARCHAR(200),
    "avatar_url" VARCHAR(500),
    "phone" VARCHAR(20),
    "contact_id" INTEGER,
    "last_message_preview" VARCHAR(200),
    "last_message_at" TIMESTAMPTZ(3),
    "last_inbound_at" TIMESTAMPTZ(3),
    "unread_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "zalo_oa_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zalo_oa_messages" (
    "id" BIGSERIAL NOT NULL,
    "thread_id" INTEGER NOT NULL,
    "direction" VARCHAR(3) NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "msg_id" VARCHAR(64),
    "text" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(12) NOT NULL,
    "error" VARCHAR(300),
    "sent_by" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zalo_oa_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "google_connections" (
    "id" SERIAL NOT NULL,
    "google_email" VARCHAR(255),
    "refresh_token_enc" TEXT NOT NULL,
    "access_token_enc" TEXT,
    "token_expires_at" TIMESTAMPTZ(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "last_error" VARCHAR(500),
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "google_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "google_sheet_syncs" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "direction" VARCHAR(8) NOT NULL,
    "connection_id" INTEGER NOT NULL,
    "spreadsheet_id" VARCHAR(128) NOT NULL,
    "sheet_title" VARCHAR(200) NOT NULL,
    "target_kind" VARCHAR(16) NOT NULL,
    "target_object_key" VARCHAR(48),
    "column_map" JSONB NOT NULL DEFAULT '{}',
    "dedupe_key" VARCHAR(48) NOT NULL,
    "actor_user_id" INTEGER NOT NULL,
    "contact_source_id" INTEGER,
    "schedule_minutes" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "export_cursor" BIGINT NOT NULL DEFAULT 0,
    "last_run_at" TIMESTAMPTZ(3),
    "last_status" VARCHAR(16),
    "last_error" VARCHAR(500),
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "google_sheet_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "google_sheet_sync_runs" (
    "id" BIGSERIAL NOT NULL,
    "sync_id" INTEGER NOT NULL,
    "trigger" VARCHAR(16) NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "status" VARCHAR(16) NOT NULL DEFAULT 'running',
    "stats" JSONB NOT NULL DEFAULT '{}',
    "error" VARCHAR(500),

    CONSTRAINT "google_sheet_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "briefings" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "slot" VARCHAR(16) NOT NULL,
    "day" VARCHAR(10) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "text" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "channels" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "briefings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facebook_pages" (
    "id" SERIAL NOT NULL,
    "page_id" VARCHAR(40) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "token_enc" TEXT NOT NULL,
    "token_status" VARCHAR(16) NOT NULL DEFAULT 'unknown',
    "token_checked_at" TIMESTAMPTZ(3),
    "token_expires_at" TIMESTAMPTZ(3),
    "data_access_expires_at" TIMESTAMPTZ(3),
    "subscribed" BOOLEAN NOT NULL DEFAULT false,
    "default_assignee_id" INTEGER NOT NULL,
    "contact_source_id" INTEGER NOT NULL,
    "project_id" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "connected_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "facebook_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facebook_conversations" (
    "id" SERIAL NOT NULL,
    "page_id" VARCHAR(40) NOT NULL,
    "psid" VARCHAR(40) NOT NULL,
    "customer_name" VARCHAR(200),
    "contact_id" INTEGER,
    "last_inbound_at" TIMESTAMPTZ(3),
    "last_message_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_message_preview" VARCHAR(200),
    "unread_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "facebook_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facebook_messages" (
    "id" BIGSERIAL NOT NULL,
    "conversation_id" INTEGER NOT NULL,
    "mid" VARCHAR(255) NOT NULL,
    "direction" VARCHAR(3) NOT NULL,
    "text" TEXT,
    "sent_by_user_id" INTEGER,
    "sent_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "facebook_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facebook_lead_receipts" (
    "id" BIGSERIAL NOT NULL,
    "leadgen_id" VARCHAR(40) NOT NULL,
    "page_id" VARCHAR(40) NOT NULL,
    "form_id" VARCHAR(40),
    "contact_id" INTEGER,
    "result" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "facebook_lead_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extensions" (
    "id" SERIAL NOT NULL,
    "key" VARCHAR(40) NOT NULL,
    "kind" VARCHAR(8) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(1000) NOT NULL DEFAULT '',
    "status" VARCHAR(12) NOT NULL DEFAULT 'draft',
    "active_version_id" INTEGER,
    "latest_version" INTEGER NOT NULL DEFAULT 0,
    "disabled_reason" VARCHAR(1000),
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "extensions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extension_versions" (
    "id" SERIAL NOT NULL,
    "extension_id" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "note" VARCHAR(500),
    "review_status" VARCHAR(10) NOT NULL DEFAULT 'draft',
    "review_note" VARCHAR(1000),
    "created_by" INTEGER NOT NULL,
    "reviewed_by" INTEGER,
    "reviewed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extension_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "extension_runs" (
    "id" SERIAL NOT NULL,
    "extension_id" INTEGER NOT NULL,
    "version_id" INTEGER,
    "mode" VARCHAR(10) NOT NULL,
    "outcome" VARCHAR(20) NOT NULL,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "peak_rss_kb" INTEGER,
    "log" TEXT NOT NULL DEFAULT '',
    "result" JSONB,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "extension_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_team_id_status_idx" ON "users"("team_id", "status");

-- CreateIndex
CREATE INDEX "users_manager_id_idx" ON "users"("manager_id");

-- CreateIndex
CREATE INDEX "users_deleted_at_idx" ON "users"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "user_roles_user_id_role_id_key" ON "user_roles"("user_id", "role_id");

-- CreateIndex
CREATE INDEX "rbac_audit_log_target_idx" ON "rbac_audit_log"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "rbac_audit_log_created_idx" ON "rbac_audit_log"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "teams_name_key" ON "teams"("name");

-- CreateIndex
CREATE INDEX "login_wifi_check_targets_target_user_id_idx" ON "login_wifi_check_targets"("target_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "login_wifi_check_targets_scope_type_target_user_id_key" ON "login_wifi_check_targets"("scope_type", "target_user_id");

-- CreateIndex
CREATE INDEX "contacts_team_id_idx" ON "contacts"("team_id");

-- CreateIndex
CREATE INDEX "contacts_reminder_at_idx" ON "contacts"("reminder_at");

-- CreateIndex
CREATE INDEX "contacts_birthday_idx" ON "contacts"("birthday");

-- CreateIndex
CREATE INDEX "contacts_phone_idx" ON "contacts"("phone");

-- CreateIndex
CREATE INDEX "contacts_source_id_idx" ON "contacts"("source_id");

-- CreateIndex
CREATE INDEX "contacts_stage_id_idx" ON "contacts"("stage_id");

-- CreateIndex
CREATE INDEX "contacts_contact_status_id_idx" ON "contacts"("contact_status_id");

-- CreateIndex
CREATE INDEX "contacts_project_id_idx" ON "contacts"("project_id");

-- CreateIndex
CREATE INDEX "contacts_product_id_idx" ON "contacts"("product_id");

-- CreateIndex
CREATE INDEX "contacts_deleted_at_idx" ON "contacts"("deleted_at");

-- CreateIndex
CREATE INDEX "idx_contacts_created_by_id" ON "contacts"("created_by_id");

-- CreateIndex
CREATE INDEX "idx_contacts_created_at_id_desc" ON "contacts"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "idx_contacts_assigned_to_created_at_id" ON "contacts"("assigned_to", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "contact_recent_views_user_id_viewed_at_idx" ON "contact_recent_views"("user_id", "viewed_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "contact_recent_views_user_id_contact_id_key" ON "contact_recent_views"("user_id", "contact_id");

-- CreateIndex
CREATE INDEX "activities_contact_id_created_at_idx" ON "activities"("contact_id", "created_at");

-- CreateIndex
CREATE INDEX "idx_activities_action_created_at" ON "activities"("action", "created_at" DESC);

-- CreateIndex
CREATE INDEX "deals_assigned_to_status_idx" ON "deals"("assigned_to", "status");

-- CreateIndex
CREATE INDEX "deals_created_by_idx" ON "deals"("created_by");

-- CreateIndex
CREATE INDEX "deals_created_at_idx" ON "deals"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "projects_code_key" ON "projects"("code");

-- CreateIndex
CREATE UNIQUE INDEX "job_titles_rank_code_key" ON "job_titles"("rank_code");

-- CreateIndex
CREATE INDEX "job_titles_category_idx" ON "job_titles"("category");

-- CreateIndex
CREATE INDEX "job_titles_is_active_idx" ON "job_titles"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "employees_user_id_key" ON "employees"("user_id");

-- CreateIndex
CREATE INDEX "employees_job_title_id_idx" ON "employees"("job_title_id");

-- CreateIndex
CREATE INDEX "employees_office_id_idx" ON "employees"("office_id");

-- CreateIndex
CREATE INDEX "employees_deleted_at_idx" ON "employees"("deleted_at");

-- CreateIndex
CREATE INDEX "employee_contracts_employee_id_idx" ON "employee_contracts"("employee_id");

-- CreateIndex
CREATE INDEX "employee_contracts_end_date_idx" ON "employee_contracts"("end_date");

-- CreateIndex
CREATE INDEX "contract_templates_created_at_idx" ON "contract_templates"("created_at" DESC);

-- CreateIndex
CREATE INDEX "recruitment_candidates_stage_idx" ON "recruitment_candidates"("stage");

-- CreateIndex
CREATE INDEX "recruitment_candidates_source_idx" ON "recruitment_candidates"("source");

-- CreateIndex
CREATE INDEX "recruitment_candidates_applied_date_idx" ON "recruitment_candidates"("applied_date" DESC);

-- CreateIndex
CREATE INDEX "recruitment_positions_status_idx" ON "recruitment_positions"("status");

-- CreateIndex
CREATE INDEX "recruitment_positions_department_idx" ON "recruitment_positions"("department");

-- CreateIndex
CREATE INDEX "recruitment_positions_opened_date_idx" ON "recruitment_positions"("opened_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "salary_components_code_key" ON "salary_components"("code");

-- CreateIndex
CREATE INDEX "salary_components_component_type_is_active_idx" ON "salary_components"("component_type", "is_active");

-- CreateIndex
CREATE INDEX "insurance_settings_is_active_idx" ON "insurance_settings"("is_active");

-- CreateIndex
CREATE INDEX "tax_brackets_is_active_bracket_order_idx" ON "tax_brackets"("is_active", "bracket_order");

-- CreateIndex
CREATE INDEX "payroll_tax_settings_is_active_idx" ON "payroll_tax_settings"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "kpi_results_employee_id_month_metric_name_key" ON "kpi_results"("employee_id", "month", "metric_name");

-- CreateIndex
CREATE INDEX "payslips_month_deleted_at_idx" ON "payslips"("month", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "payslips_employee_id_month_key" ON "payslips"("employee_id", "month");

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_name_key" ON "notification_templates"("name");

-- CreateIndex
CREATE INDEX "notification_logs_recipient_id_created_at_idx" ON "notification_logs"("recipient_id", "created_at");

-- CreateIndex
CREATE INDEX "notification_logs_status_scheduled_at_idx" ON "notification_logs"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "notification_logs_event_type_recipient_id_created_at_idx" ON "notification_logs"("event_type", "recipient_id", "created_at");

-- CreateIndex
CREATE INDEX "setting_options_group_key_sort_order_idx" ON "setting_options"("group_key", "sort_order");

-- CreateIndex
CREATE INDEX "setting_options_group_key_is_active_idx" ON "setting_options"("group_key", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "setting_options_group_key_value_key" ON "setting_options"("group_key", "value");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_resource_created_at_idx" ON "audit_logs"("resource", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_owner_user_id_idx" ON "api_keys"("owner_user_id");

-- CreateIndex
CREATE INDEX "api_keys_revoked_at_idx" ON "api_keys"("revoked_at");

-- CreateIndex
CREATE INDEX "newsfeed_posts_category_id_idx" ON "newsfeed_posts"("category", "id" DESC);

-- CreateIndex
CREATE INDEX "newsfeed_posts_author_id_idx" ON "newsfeed_posts"("author_id");

-- CreateIndex
CREATE INDEX "newsfeed_post_images_post_id_sort_order_idx" ON "newsfeed_post_images"("post_id", "sort_order");

-- CreateIndex
CREATE INDEX "newsfeed_post_likes_post_id_idx" ON "newsfeed_post_likes"("post_id");

-- CreateIndex
CREATE UNIQUE INDEX "newsfeed_post_likes_post_id_user_id_key" ON "newsfeed_post_likes"("post_id", "user_id");

-- CreateIndex
CREATE INDEX "newsfeed_post_comments_post_id_id_idx" ON "newsfeed_post_comments"("post_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_qr_sessions_token_key" ON "attendance_qr_sessions"("token");

-- CreateIndex
CREATE INDEX "attendance_qr_sessions_is_active_expires_at_idx" ON "attendance_qr_sessions"("is_active", "expires_at");

-- CreateIndex
CREATE INDEX "attendance_records_work_date_idx" ON "attendance_records"("work_date");

-- CreateIndex
CREATE INDEX "attendance_records_user_id_work_date_idx" ON "attendance_records"("user_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_records_user_id_work_date_key" ON "attendance_records"("user_id", "work_date");

-- CreateIndex
CREATE INDEX "attendance_requests_user_id_work_date_idx" ON "attendance_requests"("user_id", "work_date" DESC);

-- CreateIndex
CREATE INDEX "attendance_requests_status_idx" ON "attendance_requests"("status");

-- CreateIndex
CREATE UNIQUE INDEX "products_code_key" ON "products"("code");

-- CreateIndex
CREATE INDEX "products_project_id_idx" ON "products"("project_id");

-- CreateIndex
CREATE INDEX "products_is_active_idx" ON "products"("is_active");

-- CreateIndex
CREATE INDEX "products_category_id_idx" ON "products"("category_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_code_key" ON "product_categories"("code");

-- CreateIndex
CREATE INDEX "product_categories_is_active_sort_order_idx" ON "product_categories"("is_active", "sort_order");

-- CreateIndex
CREATE INDEX "product_attribute_defs_category_id_sort_order_idx" ON "product_attribute_defs"("category_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "product_attribute_defs_category_id_key_key" ON "product_attribute_defs"("category_id", "key");

-- CreateIndex
CREATE INDEX "kanban_boards_is_active_deleted_at_idx" ON "kanban_boards"("is_active", "deleted_at");

-- CreateIndex
CREATE INDEX "kanban_columns_board_id_position_idx" ON "kanban_columns"("board_id", "position");

-- CreateIndex
CREATE INDEX "kanban_columns_board_id_is_archived_idx" ON "kanban_columns"("board_id", "is_archived");

-- CreateIndex
CREATE INDEX "kanban_field_defs_board_id_position_idx" ON "kanban_field_defs"("board_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "kanban_field_defs_board_id_key_key" ON "kanban_field_defs"("board_id", "key");

-- CreateIndex
CREATE INDEX "kanban_cards_board_id_column_id_position_idx" ON "kanban_cards"("board_id", "column_id", "position");

-- CreateIndex
CREATE INDEX "kanban_cards_created_by_board_id_idx" ON "kanban_cards"("created_by", "board_id");

-- CreateIndex
CREATE INDEX "kanban_cards_assignee_id_idx" ON "kanban_cards"("assignee_id");

-- CreateIndex
CREATE INDEX "kanban_cards_contact_id_idx" ON "kanban_cards"("contact_id");

-- CreateIndex
CREATE INDEX "kanban_cards_board_id_deleted_at_idx" ON "kanban_cards"("board_id", "deleted_at");

-- CreateIndex
CREATE INDEX "kanban_card_assignees_user_id_idx" ON "kanban_card_assignees"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "kanban_card_assignees_card_id_user_id_key" ON "kanban_card_assignees"("card_id", "user_id");

-- CreateIndex
CREATE INDEX "kanban_checklist_items_card_id_position_idx" ON "kanban_checklist_items"("card_id", "position");

-- CreateIndex
CREATE INDEX "kanban_card_attachments_card_id_idx" ON "kanban_card_attachments"("card_id");

-- CreateIndex
CREATE INDEX "kanban_card_activities_card_id_created_at_idx" ON "kanban_card_activities"("card_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "pos_areas_name_key" ON "pos_areas"("name");

-- CreateIndex
CREATE UNIQUE INDEX "pos_tables_area_id_name_key" ON "pos_tables"("area_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "pos_modifiers_group_name_name_key" ON "pos_modifiers"("group_name", "name");

-- CreateIndex
CREATE INDEX "pos_shifts_opened_by_status_idx" ON "pos_shifts"("opened_by", "status");

-- CreateIndex
CREATE INDEX "pos_shifts_opened_at_idx" ON "pos_shifts"("opened_at");

-- CreateIndex
CREATE UNIQUE INDEX "pos_orders_code_key" ON "pos_orders"("code");

-- CreateIndex
CREATE INDEX "pos_orders_shift_id_idx" ON "pos_orders"("shift_id");

-- CreateIndex
CREATE INDEX "pos_orders_status_created_at_idx" ON "pos_orders"("status", "created_at");

-- CreateIndex
CREATE INDEX "pos_orders_table_id_status_idx" ON "pos_orders"("table_id", "status");

-- CreateIndex
CREATE INDEX "pos_orders_paid_at_idx" ON "pos_orders"("paid_at");

-- CreateIndex
CREATE INDEX "pos_order_items_order_id_idx" ON "pos_order_items"("order_id");

-- CreateIndex
CREATE INDEX "pos_order_items_product_id_idx" ON "pos_order_items"("product_id");

-- CreateIndex
CREATE INDEX "pos_payments_order_id_idx" ON "pos_payments"("order_id");

-- CreateIndex
CREATE INDEX "pos_payments_shift_id_method_idx" ON "pos_payments"("shift_id", "method");

-- CreateIndex
CREATE INDEX "integration_audit_logs_created_idx" ON "integration_audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "integration_audit_logs_channel_created_idx" ON "integration_audit_logs"("channel", "created_at" DESC);

-- CreateIndex
CREATE INDEX "integration_audit_logs_user_created_idx" ON "integration_audit_logs"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "integration_events_dispatch_idx" ON "integration_events"("dispatched_at", "id");

-- CreateIndex
CREATE INDEX "integration_events_created_idx" ON "integration_events"("created_at");

-- CreateIndex
CREATE INDEX "webhook_endpoints_is_active_idx" ON "webhook_endpoints"("is_active");

-- CreateIndex
CREATE INDEX "webhook_endpoints_created_by_idx" ON "webhook_endpoints"("created_by");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_next_idx" ON "webhook_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_endpoint_created_idx" ON "webhook_deliveries"("endpoint_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_endpoint_event_uniq" ON "webhook_deliveries"("endpoint_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_inbound_sources_token_hash_key" ON "webhook_inbound_sources"("token_hash");

-- CreateIndex
CREATE INDEX "webhook_inbound_sources_created_by_idx" ON "webhook_inbound_sources"("created_by");

-- CreateIndex
CREATE INDEX "webhook_inbound_receipts_created_idx" ON "webhook_inbound_receipts"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_inbound_receipts_source_ext_uniq" ON "webhook_inbound_receipts"("source_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_clients_client_id_key" ON "oauth_clients"("client_id");

-- CreateIndex
CREATE INDEX "oauth_clients_kind_created_idx" ON "oauth_clients"("kind", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_authorization_codes_code_hash_key" ON "oauth_authorization_codes"("code_hash");

-- CreateIndex
CREATE INDEX "oauth_codes_expires_idx" ON "oauth_authorization_codes"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_tokens_access_hash_key" ON "oauth_tokens"("access_hash");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_tokens_refresh_hash_key" ON "oauth_tokens"("refresh_hash");

-- CreateIndex
CREATE INDEX "oauth_tokens_user_revoked_idx" ON "oauth_tokens"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "oauth_tokens_family_idx" ON "oauth_tokens"("family_id");

-- CreateIndex
CREATE INDEX "oauth_tokens_refresh_exp_idx" ON "oauth_tokens"("refresh_expires_at");

-- CreateIndex
CREATE INDEX "ai_action_drafts_user_status_idx" ON "ai_action_drafts"("user_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "ai_action_drafts_status_exp_idx" ON "ai_action_drafts"("status", "expires_at");

-- CreateIndex
CREATE INDEX "custom_objects_nav_idx" ON "custom_objects"("deleted_at", "show_in_nav", "nav_order");

-- CreateIndex
CREATE INDEX "custom_fields_object_idx" ON "custom_fields"("object_id", "deleted_at", "sort_order");

-- CreateIndex
CREATE INDEX "custom_records_object_idx" ON "custom_records"("object_id", "deleted_at", "id" DESC);

-- CreateIndex
CREATE INDEX "custom_records_owner_idx" ON "custom_records"("object_id", "owner_id");

-- CreateIndex
CREATE INDEX "custom_records_creator_idx" ON "custom_records"("object_id", "created_by");

-- CreateIndex
CREATE UNIQUE INDEX "custom_records_object_code_seq_uq" ON "custom_records"("object_id", "code_seq");

-- CreateIndex
CREATE INDEX "custom_views_object_idx" ON "custom_views"("object_id", "deleted_at");

-- CreateIndex
CREATE INDEX "custom_views_nav_idx" ON "custom_views"("deleted_at", "show_in_nav", "nav_order");

-- CreateIndex
CREATE INDEX "record_links_target_idx" ON "record_links"("target_type", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "record_links_edge_uq" ON "record_links"("source_type", "source_id", "source_field", "target_type", "target_id");

-- CreateIndex
CREATE INDEX "custom_schema_versions_created_idx" ON "custom_schema_versions"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "zalo_oa_connections_oa_id_key" ON "zalo_oa_connections"("oa_id");

-- CreateIndex
CREATE INDEX "zalo_oa_oauth_states_expires_at_idx" ON "zalo_oa_oauth_states"("expires_at");

-- CreateIndex
CREATE INDEX "zalo_oa_threads_last_msg_idx" ON "zalo_oa_threads"("last_message_at" DESC);

-- CreateIndex
CREATE INDEX "zalo_oa_threads_contact_id_idx" ON "zalo_oa_threads"("contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "zalo_oa_threads_oa_id_zalo_user_id_key" ON "zalo_oa_threads"("oa_id", "zalo_user_id");

-- CreateIndex
CREATE INDEX "zalo_oa_messages_thread_idx" ON "zalo_oa_messages"("thread_id", "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "zalo_oa_messages_thread_id_msg_id_key" ON "zalo_oa_messages"("thread_id", "msg_id");

-- CreateIndex
CREATE INDEX "google_connections_status_idx" ON "google_connections"("status");

-- CreateIndex
CREATE INDEX "google_sheet_syncs_active_idx" ON "google_sheet_syncs"("is_active", "deleted_at");

-- CreateIndex
CREATE INDEX "google_sheet_sync_runs_sync_idx" ON "google_sheet_sync_runs"("sync_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "briefings_user_id_created_at_idx" ON "briefings"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "briefings_user_id_slot_day_key" ON "briefings"("user_id", "slot", "day");

-- CreateIndex
CREATE UNIQUE INDEX "facebook_pages_page_id_key" ON "facebook_pages"("page_id");

-- CreateIndex
CREATE INDEX "facebook_conversations_last_idx" ON "facebook_conversations"("last_message_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "facebook_conversations_page_psid_uniq" ON "facebook_conversations"("page_id", "psid");

-- CreateIndex
CREATE UNIQUE INDEX "facebook_messages_mid_key" ON "facebook_messages"("mid");

-- CreateIndex
CREATE INDEX "facebook_messages_conv_idx" ON "facebook_messages"("conversation_id", "sent_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "facebook_lead_receipts_leadgen_id_key" ON "facebook_lead_receipts"("leadgen_id");

-- CreateIndex
CREATE INDEX "facebook_lead_receipts_created_idx" ON "facebook_lead_receipts"("created_at");

-- CreateIndex
CREATE INDEX "extensions_status_kind_idx" ON "extensions"("status", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "extension_versions_ext_ver_uq" ON "extension_versions"("extension_id", "version");

-- CreateIndex
CREATE INDEX "extension_runs_ext_idx" ON "extension_runs"("extension_id", "id" DESC);

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "setting_options"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "setting_options"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_contact_status_id_fkey" FOREIGN KEY ("contact_status_id") REFERENCES "setting_options"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "attendance_offices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_job_title_id_fkey" FOREIGN KEY ("job_title_id") REFERENCES "job_titles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_contracts" ADD CONSTRAINT "employee_contracts_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salary_rule_details" ADD CONSTRAINT "salary_rule_details_salary_rule_id_fkey" FOREIGN KEY ("salary_rule_id") REFERENCES "salary_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kpi_results" ADD CONSTRAINT "kpi_results_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsfeed_posts" ADD CONSTRAINT "newsfeed_posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsfeed_post_images" ADD CONSTRAINT "newsfeed_post_images_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "newsfeed_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsfeed_post_likes" ADD CONSTRAINT "newsfeed_post_likes_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "newsfeed_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsfeed_post_likes" ADD CONSTRAINT "newsfeed_post_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsfeed_post_comments" ADD CONSTRAINT "newsfeed_post_comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "newsfeed_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "newsfeed_post_comments" ADD CONSTRAINT "newsfeed_post_comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_qr_sessions" ADD CONSTRAINT "attendance_qr_sessions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_requests" ADD CONSTRAINT "attendance_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_requests" ADD CONSTRAINT "attendance_requests_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "product_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_attribute_defs" ADD CONSTRAINT "product_attribute_defs_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "product_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_columns" ADD CONSTRAINT "kanban_columns_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "kanban_boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_field_defs" ADD CONSTRAINT "kanban_field_defs_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "kanban_boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_cards" ADD CONSTRAINT "kanban_cards_board_id_fkey" FOREIGN KEY ("board_id") REFERENCES "kanban_boards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_cards" ADD CONSTRAINT "kanban_cards_column_id_fkey" FOREIGN KEY ("column_id") REFERENCES "kanban_columns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_card_assignees" ADD CONSTRAINT "kanban_card_assignees_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "kanban_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_checklist_items" ADD CONSTRAINT "kanban_checklist_items_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "kanban_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_card_attachments" ADD CONSTRAINT "kanban_card_attachments_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "kanban_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kanban_card_activities" ADD CONSTRAINT "kanban_card_activities_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "kanban_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_tables" ADD CONSTRAINT "pos_tables_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "pos_areas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_orders" ADD CONSTRAINT "pos_orders_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "pos_shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_order_items" ADD CONSTRAINT "pos_order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "pos_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_payments" ADD CONSTRAINT "pos_payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "pos_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pos_payments" ADD CONSTRAINT "pos_payments_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "pos_shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_fields" ADD CONSTRAINT "custom_fields_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "custom_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_records" ADD CONSTRAINT "custom_records_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "custom_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_views" ADD CONSTRAINT "custom_views_object_id_fkey" FOREIGN KEY ("object_id") REFERENCES "custom_objects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zalo_oa_messages" ADD CONSTRAINT "zalo_oa_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "zalo_oa_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "google_sheet_sync_runs" ADD CONSTRAINT "google_sheet_sync_runs_sync_id_fkey" FOREIGN KEY ("sync_id") REFERENCES "google_sheet_syncs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extension_versions" ADD CONSTRAINT "extension_versions_extension_id_fkey" FOREIGN KEY ("extension_id") REFERENCES "extensions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extension_runs" ADD CONSTRAINT "extension_runs_extension_id_fkey" FOREIGN KEY ("extension_id") REFERENCES "extensions"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ============================================================================
-- PHẦN PRISMA KHÔNG SINH ĐƯỢC (viết tay): sequence, hàm, trigger, index từng phần,
-- dòng cấu hình khởi tạo. Idempotent (IF NOT EXISTS / OR REPLACE).
-- ============================================================================

-- Mỗi user tối đa 1 ca POS đang mở.
CREATE UNIQUE INDEX IF NOT EXISTS "pos_shifts_one_open_per_user" ON "pos_shifts"("opened_by") WHERE "status" = 'open';

-- Dòng cấu hình POS singleton.
INSERT INTO "pos_settings" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;

-- Thực thể tuỳ biến: key duy nhất trong số bản ghi CÒN SỐNG (xoá mềm xong được tạo lại cùng key).
CREATE UNIQUE INDEX IF NOT EXISTS "custom_objects_key_live_uq" ON "custom_objects"("key") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "custom_fields_object_key_live_uq" ON "custom_fields"("object_id", "key") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "custom_fields_one_title_uq" ON "custom_fields"("object_id") WHERE "is_title" AND "deleted_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "custom_views_object_key_live_uq" ON "custom_views"("object_id", "key") WHERE "deleted_at" IS NULL;

-- Chương trình con (add-on): mã duy nhất trong số bản ghi còn sống.
CREATE UNIQUE INDEX IF NOT EXISTS "extensions_key_live_uq" ON "extensions"("key") WHERE "deleted_at" IS NULL;

-- Mã chung cho bản ghi: khách hàng KH001…, deal DL001…, công việc CV001…, bản ghi tuỳ biến theo tiền tố bảng.
-- Cấp mã bằng TRIGGER BEFORE INSERT để mọi đường ghi (form, import, MCP) đều có mã.
CREATE SEQUENCE IF NOT EXISTS "contacts_code_seq";
CREATE SEQUENCE IF NOT EXISTS "deals_code_seq";
CREATE SEQUENCE IF NOT EXISTS "kanban_cards_code_seq";

-- Số thứ tự → phần số của mã: 1 → 001, 999 → 999, 1000 → 1000 (đệm 3 chữ số, không cắt).
CREATE OR REPLACE FUNCTION trinity_code_num(p_seq BIGINT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_seq < 1000 THEN lpad(p_seq::text, 3, '0') ELSE p_seq::text END
$$;

-- Tiền tố dành cho bảng lõi — bảng tuỳ biến không được lấy.
CREATE OR REPLACE FUNCTION trinity_reserved_code_prefixes() RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['KH', 'DL', 'CV']::text[]
$$;

-- Tiền tố đã có chủ (bảng lõi, tiền tố hiện tại hoặc CŨ của bảng khác, kể cả bảng đã xoá).
CREATE OR REPLACE FUNCTION trinity_code_prefix_taken(p_prefix TEXT, p_self_id INTEGER) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT p_prefix = ANY(trinity_reserved_code_prefixes())
      OR EXISTS (SELECT 1 FROM custom_objects o WHERE o.id IS DISTINCT FROM p_self_id
                 AND (o.code_prefix = p_prefix OR p_prefix = ANY(o.code_prefix_aliases)))
$$;

-- Sinh tiền tố từ tên bảng: chữ đầu mỗi từ (tối đa 4) — "Học sinh" → HS, "Bệnh nhân" → BN; một từ → 2 chữ đầu ("Khoá" → KH).
-- Trùng ⇒ nối thêm chữ kế tiếp của từ cuối ("Khoá học" → KHO), rồi thêm A–Z. Bỏ dấu tiếng Việt, chỉ A–Z.
CREATE OR REPLACE FUNCTION trinity_pick_code_prefix(p_label TEXT, p_self_id INTEGER) RETURNS TEXT LANGUAGE plpgsql AS $$
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

-- 4) Trigger cấp mã cho bản ghi MỚI.
CREATE OR REPLACE FUNCTION trinity_custom_objects_code_prefix() RETURNS TRIGGER LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE FUNCTION trinity_custom_records_code() RETURNS TRIGGER LANGUAGE plpgsql AS $$
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

CREATE OR REPLACE FUNCTION trinity_core_code() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IS NULL THEN
    NEW.code := TG_ARGV[0] || trinity_code_num(nextval(TG_ARGV[1]::regclass));
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trinity_custom_objects_code_prefix ON custom_objects;
CREATE TRIGGER trinity_custom_objects_code_prefix BEFORE INSERT ON custom_objects
  FOR EACH ROW EXECUTE FUNCTION trinity_custom_objects_code_prefix();
DROP TRIGGER IF EXISTS trinity_custom_records_code ON custom_records;
CREATE TRIGGER trinity_custom_records_code BEFORE INSERT ON custom_records
  FOR EACH ROW EXECUTE FUNCTION trinity_custom_records_code();
DROP TRIGGER IF EXISTS trinity_contacts_code ON contacts;
CREATE TRIGGER trinity_contacts_code BEFORE INSERT ON contacts
  FOR EACH ROW EXECUTE FUNCTION trinity_core_code('KH', 'contacts_code_seq');
DROP TRIGGER IF EXISTS trinity_deals_code ON deals;
CREATE TRIGGER trinity_deals_code BEFORE INSERT ON deals
  FOR EACH ROW EXECUTE FUNCTION trinity_core_code('DL', 'deals_code_seq');
DROP TRIGGER IF EXISTS trinity_kanban_cards_code ON kanban_cards;
CREATE TRIGGER trinity_kanban_cards_code BEFORE INSERT ON kanban_cards
  FOR EACH ROW EXECUTE FUNCTION trinity_core_code('CV', 'kanban_cards_code_seq');

-- 5) Chỉ mục: mã duy nhất + tra theo tiền tố (LIKE 'HS%' dùng varchar_pattern_ops), tìm tên theo tiền tố.
CREATE UNIQUE INDEX IF NOT EXISTS "custom_objects_code_prefix_uq" ON "custom_objects"("code_prefix") WHERE "code_prefix" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "custom_records_code_uq" ON "custom_records"("code" varchar_pattern_ops);
CREATE UNIQUE INDEX IF NOT EXISTS "custom_records_object_code_seq_uq" ON "custom_records"("object_id", "code_seq");
CREATE INDEX IF NOT EXISTS "custom_records_title_lower_idx" ON "custom_records"(lower("title") varchar_pattern_ops) WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "contacts_code_uq" ON "contacts"("code" varchar_pattern_ops);
CREATE UNIQUE INDEX IF NOT EXISTS "deals_code_uq" ON "deals"("code" varchar_pattern_ops);
CREATE UNIQUE INDEX IF NOT EXISTS "kanban_cards_code_uq" ON "kanban_cards"("code" varchar_pattern_ops);

-- Trạng thái dựng quy trình: DB mới tinh = chưa dựng (menu "mở ra trống").
INSERT INTO "settings" ("key", "value", "updated_at") VALUES ('setup_status', 'chua_dung', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
