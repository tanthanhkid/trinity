//! SINH TỰ ĐỘNG bởi `cargo xtask gen-models` từ `server/prisma/schema.prisma`. KHÔNG SỬA TAY.
//!
//! Struct model ứng với model Prisma còn dùng (thứ tự trường như schema = thứ tự khoá JSON của bản Node); kiểu
//! cột theo [`crate::types`]. Model đã thành bảng lưu trữ không có ở đây.

use crate::types::{DbDate, DecimalJs, JsBigInt, JsNumber, JsonValue, NaiveTimestamp, PgList, Timestamp};

/// Một cột: tên, kiểu Postgres (`udt_name`), có nhận NULL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Column {
    pub name: &'static str,
    pub pg_type: &'static str,
    pub nullable: bool,
}

/// Một model: tên Prisma, tên bảng, các cột vô hướng.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelInfo {
    pub name: &'static str,
    pub table: &'static str,
    pub columns: &'static [Column],
}

/// Struct model có bảng và danh sách cột.
pub trait Model {
    const INFO: ModelInfo;
}

/// Enum Prisma `NewsfeedMediaType` (kiểu Postgres `"NewsfeedMediaType"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, sqlx::Type)]
#[sqlx(type_name = "NewsfeedMediaType")]
#[allow(non_camel_case_types)]
pub enum NewsfeedMediaType {
    #[serde(rename = "image")]
    #[sqlx(rename = "image")]
    image,
    #[serde(rename = "video")]
    #[sqlx(rename = "video")]
    video,
}

/// Model `User`, bảng `users`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct User {
    pub id: i32,
    pub email: String,
    pub password_hash: String,
    pub password_updated_at: Option<Timestamp>,
    pub tokens_valid_after: Option<Timestamp>,
    pub full_name: String,
    pub phone: Option<String>,
    pub avatar_url: Option<String>,
    pub team_id: Option<i32>,
    pub manager_id: Option<i32>,
    pub status: String,
    pub deleted_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub pinned_menu_keys: PgList<String>,
}

impl Model for User {
    const INFO: ModelInfo = ModelInfo {
        name: "User",
        table: "users",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "email", pg_type: "text", nullable: false },
            Column { name: "password_hash", pg_type: "text", nullable: false },
            Column { name: "password_updated_at", pg_type: "timestamptz", nullable: true },
            Column { name: "tokens_valid_after", pg_type: "timestamptz", nullable: true },
            Column { name: "full_name", pg_type: "text", nullable: false },
            Column { name: "phone", pg_type: "text", nullable: true },
            Column { name: "avatar_url", pg_type: "text", nullable: true },
            Column { name: "team_id", pg_type: "int4", nullable: true },
            Column { name: "manager_id", pg_type: "int4", nullable: true },
            Column { name: "status", pg_type: "text", nullable: false },
            Column { name: "deleted_at", pg_type: "timestamptz", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
            Column { name: "pinned_menu_keys", pg_type: "_text", nullable: true },
        ],
    };
}

/// Model `Role`, bảng `roles`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct Role {
    pub id: i32,
    pub name: String,
    pub description: Option<String>,
    pub is_system: bool,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for Role {
    const INFO: ModelInfo = ModelInfo {
        name: "Role",
        table: "roles",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "name", pg_type: "text", nullable: false },
            Column { name: "description", pg_type: "text", nullable: true },
            Column { name: "is_system", pg_type: "bool", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `UserRole`, bảng `user_roles`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct UserRole {
    pub id: i32,
    pub user_id: i32,
    pub role_id: i32,
}

impl Model for UserRole {
    const INFO: ModelInfo = ModelInfo {
        name: "UserRole",
        table: "user_roles",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "user_id", pg_type: "int4", nullable: false },
            Column { name: "role_id", pg_type: "int4", nullable: false },
        ],
    };
}

/// Model `RolePermission`, bảng `role_permissions`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct RolePermission {
    pub role_id: i32,
    pub permission: String,
    pub scope: Option<String>,
}

impl Model for RolePermission {
    const INFO: ModelInfo = ModelInfo {
        name: "RolePermission",
        table: "role_permissions",
        columns: &[
            Column { name: "role_id", pg_type: "int4", nullable: false },
            Column { name: "permission", pg_type: "text", nullable: false },
            Column { name: "scope", pg_type: "text", nullable: true },
        ],
    };
}

/// Model `RbacAuditLog`, bảng `rbac_audit_log`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct RbacAuditLog {
    pub id: JsBigInt,
    pub actor_id: i32,
    pub action: String,
    pub target_type: String,
    pub target_id: i32,
    pub before: Option<JsonValue>,
    pub after: Option<JsonValue>,
    pub created_at: Timestamp,
}

impl Model for RbacAuditLog {
    const INFO: ModelInfo = ModelInfo {
        name: "RbacAuditLog",
        table: "rbac_audit_log",
        columns: &[
            Column { name: "id", pg_type: "int8", nullable: false },
            Column { name: "actor_id", pg_type: "int4", nullable: false },
            Column { name: "action", pg_type: "text", nullable: false },
            Column { name: "target_type", pg_type: "text", nullable: false },
            Column { name: "target_id", pg_type: "int4", nullable: false },
            Column { name: "before", pg_type: "jsonb", nullable: true },
            Column { name: "after", pg_type: "jsonb", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `Team`, bảng `teams`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct Team {
    pub id: i32,
    pub name: String,
    pub description: Option<String>,
    pub department: Option<String>,
    pub team_lead_id: Option<i32>,
    pub color: Option<String>,
    pub created_at: Timestamp,
}

impl Model for Team {
    const INFO: ModelInfo = ModelInfo {
        name: "Team",
        table: "teams",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "name", pg_type: "text", nullable: false },
            Column { name: "description", pg_type: "text", nullable: true },
            Column { name: "department", pg_type: "text", nullable: true },
            Column { name: "team_lead_id", pg_type: "int4", nullable: true },
            Column { name: "color", pg_type: "varchar", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `LoginWifiCheckTarget`, bảng `login_wifi_check_targets`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct LoginWifiCheckTarget {
    pub id: i32,
    pub scope_type: String,
    pub target_user_id: i32,
    pub created_at: NaiveTimestamp,
    pub created_by: Option<i32>,
}

impl Model for LoginWifiCheckTarget {
    const INFO: ModelInfo = ModelInfo {
        name: "LoginWifiCheckTarget",
        table: "login_wifi_check_targets",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "scope_type", pg_type: "varchar", nullable: false },
            Column { name: "target_user_id", pg_type: "int4", nullable: false },
            Column { name: "created_at", pg_type: "timestamp", nullable: false },
            Column { name: "created_by", pg_type: "int4", nullable: true },
        ],
    };
}

/// Model `Contact`, bảng `contacts`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct Contact {
    pub id: i32,
    pub code: Option<String>,
    pub phone: String,
    pub phone_2: Option<String>,
    pub zalo_account: Option<String>,
    pub full_name: Option<String>,
    pub source_id: Option<i32>,
    pub source_locked: bool,
    pub stage_id: Option<i32>,
    pub contact_status_id: Option<i32>,
    pub reminder_at: Option<Timestamp>,
    pub reminder_notes: Option<String>,
    pub birthday: Option<Timestamp>,
    pub job_title: Option<String>,
    pub assigned_to: Option<i32>,
    pub team_id: Option<i32>,
    pub created_by_id: Option<i32>,
    pub gender: Option<String>,
    pub current_address: Option<String>,
    pub company_name: Option<String>,
    pub email: Option<String>,
    pub custom_fields: JsonValue,
    pub project_id: Option<i32>,
    pub product_id: Option<i32>,
    pub avatar_url: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub deleted_at: Option<NaiveTimestamp>,
    pub deleted_by_id: Option<i32>,
    pub lead_score: Option<i32>,
    pub lead_label: Option<String>,
    pub lead_score_reasons: Option<JsonValue>,
    pub lead_scored_at: Option<Timestamp>,
}

impl Model for Contact {
    const INFO: ModelInfo = ModelInfo {
        name: "Contact",
        table: "contacts",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "code", pg_type: "varchar", nullable: true },
            Column { name: "phone", pg_type: "text", nullable: false },
            Column { name: "phone_2", pg_type: "text", nullable: true },
            Column { name: "zalo_account", pg_type: "text", nullable: true },
            Column { name: "full_name", pg_type: "text", nullable: true },
            Column { name: "source_id", pg_type: "int4", nullable: true },
            Column { name: "source_locked", pg_type: "bool", nullable: false },
            Column { name: "stage_id", pg_type: "int4", nullable: true },
            Column { name: "contact_status_id", pg_type: "int4", nullable: true },
            Column { name: "reminder_at", pg_type: "timestamptz", nullable: true },
            Column { name: "reminder_notes", pg_type: "text", nullable: true },
            Column { name: "birthday", pg_type: "timestamptz", nullable: true },
            Column { name: "job_title", pg_type: "text", nullable: true },
            Column { name: "assigned_to", pg_type: "int4", nullable: true },
            Column { name: "team_id", pg_type: "int4", nullable: true },
            Column { name: "created_by_id", pg_type: "int4", nullable: true },
            Column { name: "gender", pg_type: "text", nullable: true },
            Column { name: "current_address", pg_type: "text", nullable: true },
            Column { name: "company_name", pg_type: "text", nullable: true },
            Column { name: "email", pg_type: "text", nullable: true },
            Column { name: "custom_fields", pg_type: "jsonb", nullable: false },
            Column { name: "project_id", pg_type: "int4", nullable: true },
            Column { name: "product_id", pg_type: "int4", nullable: true },
            Column { name: "avatar_url", pg_type: "text", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
            Column { name: "deleted_at", pg_type: "timestamp", nullable: true },
            Column { name: "deleted_by_id", pg_type: "int4", nullable: true },
            Column { name: "lead_score", pg_type: "int4", nullable: true },
            Column { name: "lead_label", pg_type: "varchar", nullable: true },
            Column { name: "lead_score_reasons", pg_type: "jsonb", nullable: true },
            Column { name: "lead_scored_at", pg_type: "timestamptz", nullable: true },
        ],
    };
}

/// Model `ContactRecentView`, bảng `contact_recent_views`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct ContactRecentView {
    pub id: i32,
    pub user_id: i32,
    pub contact_id: i32,
    pub viewed_at: Timestamp,
}

impl Model for ContactRecentView {
    const INFO: ModelInfo = ModelInfo {
        name: "ContactRecentView",
        table: "contact_recent_views",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "user_id", pg_type: "int4", nullable: false },
            Column { name: "contact_id", pg_type: "int4", nullable: false },
            Column { name: "viewed_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `Activity`, bảng `activities`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct Activity {
    pub id: i32,
    pub contact_id: Option<i32>,
    pub action: String,
    pub details: Option<JsonValue>,
    pub metadata: Option<JsonValue>,
    pub created_by: Option<i32>,
    pub created_at: Timestamp,
}

impl Model for Activity {
    const INFO: ModelInfo = ModelInfo {
        name: "Activity",
        table: "activities",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "contact_id", pg_type: "int4", nullable: true },
            Column { name: "action", pg_type: "text", nullable: false },
            Column { name: "details", pg_type: "jsonb", nullable: true },
            Column { name: "metadata", pg_type: "jsonb", nullable: true },
            Column { name: "created_by", pg_type: "int4", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `Deal`, bảng `deals`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct Deal {
    pub id: i32,
    pub code: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub value: Option<JsBigInt>,
    pub status: String,
    pub note: Option<String>,
    pub assigned_to: i32,
    pub created_by: i32,
    pub contact_id: Option<i32>,
    pub won_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for Deal {
    const INFO: ModelInfo = ModelInfo {
        name: "Deal",
        table: "deals",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "code", pg_type: "varchar", nullable: true },
            Column { name: "title", pg_type: "text", nullable: false },
            Column { name: "description", pg_type: "text", nullable: true },
            Column { name: "value", pg_type: "int8", nullable: true },
            Column { name: "status", pg_type: "text", nullable: false },
            Column { name: "note", pg_type: "text", nullable: true },
            Column { name: "assigned_to", pg_type: "int4", nullable: false },
            Column { name: "created_by", pg_type: "int4", nullable: false },
            Column { name: "contact_id", pg_type: "int4", nullable: true },
            Column { name: "won_at", pg_type: "timestamptz", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `Project`, bảng `projects`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct Project {
    pub id: i32,
    pub name: String,
    pub code: String,
    pub color: Option<String>,
    pub is_active: bool,
    pub created_by: Option<i32>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for Project {
    const INFO: ModelInfo = ModelInfo {
        name: "Project",
        table: "projects",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "name", pg_type: "varchar", nullable: false },
            Column { name: "code", pg_type: "varchar", nullable: false },
            Column { name: "color", pg_type: "varchar", nullable: true },
            Column { name: "is_active", pg_type: "bool", nullable: false },
            Column { name: "created_by", pg_type: "int4", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `JobTitle`, bảng `job_titles`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct JobTitle {
    pub id: i32,
    pub category: String,
    pub rank_code: String,
    pub name: String,
    pub symbol: String,
    pub base_salary: JsBigInt,
    pub standard_target: JsBigInt,
    pub default_insurance_salary: Option<JsBigInt>,
    pub review_cycle_months: i32,
    pub is_active: bool,
    pub sort_order: i32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for JobTitle {
    const INFO: ModelInfo = ModelInfo {
        name: "JobTitle",
        table: "job_titles",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "category", pg_type: "text", nullable: false },
            Column { name: "rank_code", pg_type: "text", nullable: false },
            Column { name: "name", pg_type: "text", nullable: false },
            Column { name: "symbol", pg_type: "text", nullable: false },
            Column { name: "base_salary", pg_type: "int8", nullable: false },
            Column { name: "standard_target", pg_type: "int8", nullable: false },
            Column { name: "default_insurance_salary", pg_type: "int8", nullable: true },
            Column { name: "review_cycle_months", pg_type: "int4", nullable: false },
            Column { name: "is_active", pg_type: "bool", nullable: false },
            Column { name: "sort_order", pg_type: "int4", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `Employee`, bảng `employees`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct Employee {
    pub id: i32,
    pub user_id: i32,
    pub employee_code: Option<String>,
    pub position: String,
    pub department: Option<String>,
    pub gender: Option<String>,
    pub team_id: Option<i32>,
    pub salary_rule_id: Option<i32>,
    pub job_title_id: Option<i32>,
    pub insurance_salary: Option<JsBigInt>,
    pub dependents_count: i32,
    pub status: String,
    pub resigned_at: Option<Timestamp>,
    pub education_level: Option<String>,
    pub recruitment_source: Option<String>,
    pub deleted_at: Option<Timestamp>,
    pub joined_at: Timestamp,
    pub created_at: Timestamp,
    pub office_id: Option<i32>,
    pub registered_device_id: Option<String>,
    pub device_registered_at: Option<Timestamp>,
    pub birth_date: Option<Timestamp>,
    pub id_card_number: Option<String>,
    pub id_card_issued_date: Option<Timestamp>,
    pub id_card_issued_place: Option<String>,
    pub permanent_address: Option<String>,
    pub current_address: Option<String>,
    pub bank_account_number: Option<String>,
    pub bank_name: Option<String>,
    pub bank_account_holder: Option<String>,
}

impl Model for Employee {
    const INFO: ModelInfo = ModelInfo {
        name: "Employee",
        table: "employees",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "user_id", pg_type: "int4", nullable: false },
            Column { name: "employee_code", pg_type: "varchar", nullable: true },
            Column { name: "position", pg_type: "text", nullable: false },
            Column { name: "department", pg_type: "text", nullable: true },
            Column { name: "gender", pg_type: "text", nullable: true },
            Column { name: "team_id", pg_type: "int4", nullable: true },
            Column { name: "salary_rule_id", pg_type: "int4", nullable: true },
            Column { name: "job_title_id", pg_type: "int4", nullable: true },
            Column { name: "insurance_salary", pg_type: "int8", nullable: true },
            Column { name: "dependents_count", pg_type: "int4", nullable: false },
            Column { name: "status", pg_type: "text", nullable: false },
            Column { name: "resigned_at", pg_type: "timestamptz", nullable: true },
            Column { name: "education_level", pg_type: "text", nullable: true },
            Column { name: "recruitment_source", pg_type: "text", nullable: true },
            Column { name: "deleted_at", pg_type: "timestamptz", nullable: true },
            Column { name: "joined_at", pg_type: "timestamptz", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "office_id", pg_type: "int4", nullable: true },
            Column { name: "registered_device_id", pg_type: "varchar", nullable: true },
            Column { name: "device_registered_at", pg_type: "timestamptz", nullable: true },
            Column { name: "birth_date", pg_type: "timestamptz", nullable: true },
            Column { name: "id_card_number", pg_type: "varchar", nullable: true },
            Column { name: "id_card_issued_date", pg_type: "timestamptz", nullable: true },
            Column { name: "id_card_issued_place", pg_type: "text", nullable: true },
            Column { name: "permanent_address", pg_type: "text", nullable: true },
            Column { name: "current_address", pg_type: "text", nullable: true },
            Column { name: "bank_account_number", pg_type: "varchar", nullable: true },
            Column { name: "bank_name", pg_type: "text", nullable: true },
            Column { name: "bank_account_holder", pg_type: "text", nullable: true },
        ],
    };
}

/// Model `EmployeeContract`, bảng `employee_contracts`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct EmployeeContract {
    pub id: i32,
    pub employee_id: i32,
    pub contract_type: String,
    pub signed_date: Timestamp,
    pub end_date: Option<Timestamp>,
    pub file_url: Option<String>,
    pub notes: Option<String>,
    pub is_terminated: bool,
    pub terminated_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for EmployeeContract {
    const INFO: ModelInfo = ModelInfo {
        name: "EmployeeContract",
        table: "employee_contracts",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "employee_id", pg_type: "int4", nullable: false },
            Column { name: "contract_type", pg_type: "text", nullable: false },
            Column { name: "signed_date", pg_type: "timestamptz", nullable: false },
            Column { name: "end_date", pg_type: "timestamptz", nullable: true },
            Column { name: "file_url", pg_type: "text", nullable: true },
            Column { name: "notes", pg_type: "text", nullable: true },
            Column { name: "is_terminated", pg_type: "bool", nullable: false },
            Column { name: "terminated_at", pg_type: "timestamptz", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `EmploymentPeriod`, bảng `employment_periods`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct EmploymentPeriod {
    pub id: i32,
    pub employee_id: i32,
    pub started_on: Option<DbDate>,
    pub ended_on: Option<DbDate>,
    pub created_at: Timestamp,
}

impl Model for EmploymentPeriod {
    const INFO: ModelInfo = ModelInfo {
        name: "EmploymentPeriod",
        table: "employment_periods",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "employee_id", pg_type: "int4", nullable: false },
            Column { name: "started_on", pg_type: "date", nullable: true },
            Column { name: "ended_on", pg_type: "date", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `ContractTemplate`, bảng `contract_templates`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct ContractTemplate {
    pub id: i32,
    pub name: String,
    pub storage_key: String,
    pub mime: String,
    pub size: i32,
    pub uploaded_by: Option<i32>,
    pub created_at: Timestamp,
}

impl Model for ContractTemplate {
    const INFO: ModelInfo = ModelInfo {
        name: "ContractTemplate",
        table: "contract_templates",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "name", pg_type: "text", nullable: false },
            Column { name: "storage_key", pg_type: "text", nullable: false },
            Column { name: "mime", pg_type: "text", nullable: false },
            Column { name: "size", pg_type: "int4", nullable: false },
            Column { name: "uploaded_by", pg_type: "int4", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `RecruitmentCandidate`, bảng `recruitment_candidates`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct RecruitmentCandidate {
    pub id: i32,
    pub full_name: String,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub position: Option<String>,
    pub department: Option<String>,
    pub source: Option<String>,
    pub stage: String,
    pub decision: String,
    pub recruitment_type: String,
    pub applied_date: Option<DbDate>,
    pub cost: Option<i32>,
    pub note: Option<String>,
    pub gender: Option<String>,
    pub interview_date: Option<DbDate>,
    pub interview_time: Option<String>,
    pub recruiter_id: Option<i32>,
    pub created_by: Option<i32>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for RecruitmentCandidate {
    const INFO: ModelInfo = ModelInfo {
        name: "RecruitmentCandidate",
        table: "recruitment_candidates",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "full_name", pg_type: "text", nullable: false },
            Column { name: "phone", pg_type: "varchar", nullable: true },
            Column { name: "email", pg_type: "text", nullable: true },
            Column { name: "position", pg_type: "text", nullable: true },
            Column { name: "department", pg_type: "text", nullable: true },
            Column { name: "source", pg_type: "text", nullable: true },
            Column { name: "stage", pg_type: "text", nullable: false },
            Column { name: "decision", pg_type: "text", nullable: false },
            Column { name: "recruitment_type", pg_type: "text", nullable: false },
            Column { name: "applied_date", pg_type: "date", nullable: true },
            Column { name: "cost", pg_type: "int4", nullable: true },
            Column { name: "note", pg_type: "text", nullable: true },
            Column { name: "gender", pg_type: "text", nullable: true },
            Column { name: "interview_date", pg_type: "date", nullable: true },
            Column { name: "interview_time", pg_type: "varchar", nullable: true },
            Column { name: "recruiter_id", pg_type: "int4", nullable: true },
            Column { name: "created_by", pg_type: "int4", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `RecruitmentPosition`, bảng `recruitment_positions`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct RecruitmentPosition {
    pub id: i32,
    pub job_code: String,
    pub department: String,
    pub team: Option<String>,
    pub position_title: String,
    pub headcount: i32,
    pub recruiter_id: Option<i32>,
    pub opened_date: Option<DbDate>,
    pub expected_start_date: Option<DbDate>,
    pub description: Option<String>,
    pub requirements: Option<String>,
    pub recruitment_cost: Option<i32>,
    pub status: String,
    pub created_by: Option<i32>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for RecruitmentPosition {
    const INFO: ModelInfo = ModelInfo {
        name: "RecruitmentPosition",
        table: "recruitment_positions",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "job_code", pg_type: "text", nullable: false },
            Column { name: "department", pg_type: "text", nullable: false },
            Column { name: "team", pg_type: "text", nullable: true },
            Column { name: "position_title", pg_type: "text", nullable: false },
            Column { name: "headcount", pg_type: "int4", nullable: false },
            Column { name: "recruiter_id", pg_type: "int4", nullable: true },
            Column { name: "opened_date", pg_type: "date", nullable: true },
            Column { name: "expected_start_date", pg_type: "date", nullable: true },
            Column { name: "description", pg_type: "text", nullable: true },
            Column { name: "requirements", pg_type: "text", nullable: true },
            Column { name: "recruitment_cost", pg_type: "int4", nullable: true },
            Column { name: "status", pg_type: "text", nullable: false },
            Column { name: "created_by", pg_type: "int4", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `SalaryRule`, bảng `salary_rules`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct SalaryRule {
    pub id: i32,
    pub position: String,
    pub name: String,
    pub description: Option<String>,
}

impl Model for SalaryRule {
    const INFO: ModelInfo = ModelInfo {
        name: "SalaryRule",
        table: "salary_rules",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "position", pg_type: "text", nullable: false },
            Column { name: "name", pg_type: "text", nullable: false },
            Column { name: "description", pg_type: "text", nullable: true },
        ],
    };
}

/// Model `SalaryRuleDetail`, bảng `salary_rule_details`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct SalaryRuleDetail {
    pub id: i32,
    pub salary_rule_id: i32,
    pub component: String,
    pub amount: Option<JsBigInt>,
    pub formula: Option<String>,
    pub params: Option<JsonValue>,
    pub order: i32,
}

impl Model for SalaryRuleDetail {
    const INFO: ModelInfo = ModelInfo {
        name: "SalaryRuleDetail",
        table: "salary_rule_details",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "salary_rule_id", pg_type: "int4", nullable: false },
            Column { name: "component", pg_type: "text", nullable: false },
            Column { name: "amount", pg_type: "int8", nullable: true },
            Column { name: "formula", pg_type: "text", nullable: true },
            Column { name: "params", pg_type: "jsonb", nullable: true },
            Column { name: "order", pg_type: "int4", nullable: false },
        ],
    };
}

/// Model `SalaryComponent`, bảng `salary_components`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct SalaryComponent {
    pub id: i32,
    pub name: String,
    pub code: String,
    pub component_type: String,
    pub calc_method: String,
    pub fixed_amount: Option<JsBigInt>,
    pub percent_value: Option<DecimalJs>,
    pub applies_to: String,
    pub is_taxable: bool,
    pub effective_from: String,
    pub effective_to: Option<String>,
    pub is_active: bool,
    pub sort_order: i32,
    pub description: Option<String>,
    pub created_by: Option<i32>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for SalaryComponent {
    const INFO: ModelInfo = ModelInfo {
        name: "SalaryComponent",
        table: "salary_components",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "name", pg_type: "text", nullable: false },
            Column { name: "code", pg_type: "text", nullable: false },
            Column { name: "component_type", pg_type: "text", nullable: false },
            Column { name: "calc_method", pg_type: "text", nullable: false },
            Column { name: "fixed_amount", pg_type: "int8", nullable: true },
            Column { name: "percent_value", pg_type: "numeric", nullable: true },
            Column { name: "applies_to", pg_type: "text", nullable: false },
            Column { name: "is_taxable", pg_type: "bool", nullable: false },
            Column { name: "effective_from", pg_type: "text", nullable: false },
            Column { name: "effective_to", pg_type: "text", nullable: true },
            Column { name: "is_active", pg_type: "bool", nullable: false },
            Column { name: "sort_order", pg_type: "int4", nullable: false },
            Column { name: "description", pg_type: "text", nullable: true },
            Column { name: "created_by", pg_type: "int4", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `InsuranceSetting`, bảng `insurance_settings`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct InsuranceSetting {
    pub id: i32,
    pub name: String,
    pub code: String,
    pub employee_rate: DecimalJs,
    pub base_cap: Option<JsBigInt>,
    pub effective_from: String,
    pub effective_to: Option<String>,
    pub is_active: bool,
    pub sort_order: i32,
    pub created_by: Option<i32>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for InsuranceSetting {
    const INFO: ModelInfo = ModelInfo {
        name: "InsuranceSetting",
        table: "insurance_settings",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "name", pg_type: "text", nullable: false },
            Column { name: "code", pg_type: "text", nullable: false },
            Column { name: "employee_rate", pg_type: "numeric", nullable: false },
            Column { name: "base_cap", pg_type: "int8", nullable: true },
            Column { name: "effective_from", pg_type: "text", nullable: false },
            Column { name: "effective_to", pg_type: "text", nullable: true },
            Column { name: "is_active", pg_type: "bool", nullable: false },
            Column { name: "sort_order", pg_type: "int4", nullable: false },
            Column { name: "created_by", pg_type: "int4", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `TaxBracket`, bảng `tax_brackets`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct TaxBracket {
    pub id: i32,
    pub bracket_order: i32,
    pub lower_bound: JsBigInt,
    pub upper_bound: Option<JsBigInt>,
    pub rate: DecimalJs,
    pub effective_from: String,
    pub effective_to: Option<String>,
    pub is_active: bool,
    pub created_by: Option<i32>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for TaxBracket {
    const INFO: ModelInfo = ModelInfo {
        name: "TaxBracket",
        table: "tax_brackets",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "bracket_order", pg_type: "int4", nullable: false },
            Column { name: "lower_bound", pg_type: "int8", nullable: false },
            Column { name: "upper_bound", pg_type: "int8", nullable: true },
            Column { name: "rate", pg_type: "numeric", nullable: false },
            Column { name: "effective_from", pg_type: "text", nullable: false },
            Column { name: "effective_to", pg_type: "text", nullable: true },
            Column { name: "is_active", pg_type: "bool", nullable: false },
            Column { name: "created_by", pg_type: "int4", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `PayrollTaxSetting`, bảng `payroll_tax_settings`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct PayrollTaxSetting {
    pub id: i32,
    pub personal_deduction: JsBigInt,
    pub dependent_deduction: JsBigInt,
    pub effective_from: String,
    pub effective_to: Option<String>,
    pub is_active: bool,
    pub created_by: Option<i32>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for PayrollTaxSetting {
    const INFO: ModelInfo = ModelInfo {
        name: "PayrollTaxSetting",
        table: "payroll_tax_settings",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "personal_deduction", pg_type: "int8", nullable: false },
            Column { name: "dependent_deduction", pg_type: "int8", nullable: false },
            Column { name: "effective_from", pg_type: "text", nullable: false },
            Column { name: "effective_to", pg_type: "text", nullable: true },
            Column { name: "is_active", pg_type: "bool", nullable: false },
            Column { name: "created_by", pg_type: "int4", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `KpiConfig`, bảng `kpi_configs`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct KpiConfig {
    pub id: i32,
    pub role: String,
    pub metric_name: String,
    pub target: DecimalJs,
    pub unit: Option<String>,
    pub weight: Option<DecimalJs>,
    pub working_days_per_month: i32,
}

impl Model for KpiConfig {
    const INFO: ModelInfo = ModelInfo {
        name: "KpiConfig",
        table: "kpi_configs",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "role", pg_type: "text", nullable: false },
            Column { name: "metric_name", pg_type: "text", nullable: false },
            Column { name: "target", pg_type: "numeric", nullable: false },
            Column { name: "unit", pg_type: "text", nullable: true },
            Column { name: "weight", pg_type: "numeric", nullable: true },
            Column { name: "working_days_per_month", pg_type: "int4", nullable: false },
        ],
    };
}

/// Model `KpiResult`, bảng `kpi_results`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct KpiResult {
    pub id: i32,
    pub employee_id: i32,
    pub month: String,
    pub metric_name: String,
    pub actual_value: DecimalJs,
    pub target_value: DecimalJs,
    pub achievement_rate: Option<DecimalJs>,
    pub achieved: bool,
    pub is_locked: bool,
    pub created_at: Timestamp,
}

impl Model for KpiResult {
    const INFO: ModelInfo = ModelInfo {
        name: "KpiResult",
        table: "kpi_results",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "employee_id", pg_type: "int4", nullable: false },
            Column { name: "month", pg_type: "text", nullable: false },
            Column { name: "metric_name", pg_type: "text", nullable: false },
            Column { name: "actual_value", pg_type: "numeric", nullable: false },
            Column { name: "target_value", pg_type: "numeric", nullable: false },
            Column { name: "achievement_rate", pg_type: "numeric", nullable: true },
            Column { name: "achieved", pg_type: "bool", nullable: false },
            Column { name: "is_locked", pg_type: "bool", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `Payslip`, bảng `payslips`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct Payslip {
    pub id: i32,
    pub employee_id: i32,
    pub month: String,
    pub base_salary: JsBigInt,
    pub kpi_bonus: JsBigInt,
    pub deductions: JsBigInt,
    pub total: JsBigInt,
    pub components_json: Option<JsonValue>,
    pub insurance_json: Option<JsonValue>,
    pub insurance_base: JsBigInt,
    pub tax_json: Option<JsonValue>,
    pub working_days: Option<DecimalJs>,
    pub standard_working_days: i32,
    pub base_salary_actual: JsBigInt,
    pub training_salary: JsBigInt,
    pub probation_allowance: JsBigInt,
    pub sales_personal: JsBigInt,
    pub bonus_rate: Option<DecimalJs>,
    pub kpi_percent: Option<DecimalJs>,
    pub bonus_sales_personal: JsBigInt,
    pub sales_team: JsBigInt,
    pub bonus_cskh_team: JsBigInt,
    pub bonus_milestone: JsBigInt,
    pub bonus_referral: JsBigInt,
    pub holiday_bonus: JsBigInt,
    pub advances: JsBigInt,
    pub training_days: Option<DecimalJs>,
    pub personal_income_tax: JsBigInt,
    pub notes: Option<String>,
    pub status: String,
    pub tl_approved_by: Option<i32>,
    pub tl_approved_at: Option<Timestamp>,
    pub approved_by: Option<i32>,
    pub approved_at: Option<Timestamp>,
    pub deleted_at: Option<Timestamp>,
    pub deleted_by: Option<i32>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for Payslip {
    const INFO: ModelInfo = ModelInfo {
        name: "Payslip",
        table: "payslips",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "employee_id", pg_type: "int4", nullable: false },
            Column { name: "month", pg_type: "text", nullable: false },
            Column { name: "base_salary", pg_type: "int8", nullable: false },
            Column { name: "kpi_bonus", pg_type: "int8", nullable: false },
            Column { name: "deductions", pg_type: "int8", nullable: false },
            Column { name: "total", pg_type: "int8", nullable: false },
            Column { name: "components_json", pg_type: "jsonb", nullable: true },
            Column { name: "insurance_json", pg_type: "jsonb", nullable: true },
            Column { name: "insurance_base", pg_type: "int8", nullable: false },
            Column { name: "tax_json", pg_type: "jsonb", nullable: true },
            Column { name: "working_days", pg_type: "numeric", nullable: true },
            Column { name: "standard_working_days", pg_type: "int4", nullable: false },
            Column { name: "base_salary_actual", pg_type: "int8", nullable: false },
            Column { name: "training_salary", pg_type: "int8", nullable: false },
            Column { name: "probation_allowance", pg_type: "int8", nullable: false },
            Column { name: "sales_personal", pg_type: "int8", nullable: false },
            Column { name: "bonus_rate", pg_type: "numeric", nullable: true },
            Column { name: "kpi_percent", pg_type: "numeric", nullable: true },
            Column { name: "bonus_sales_personal", pg_type: "int8", nullable: false },
            Column { name: "sales_team", pg_type: "int8", nullable: false },
            Column { name: "bonus_cskh_team", pg_type: "int8", nullable: false },
            Column { name: "bonus_milestone", pg_type: "int8", nullable: false },
            Column { name: "bonus_referral", pg_type: "int8", nullable: false },
            Column { name: "holiday_bonus", pg_type: "int8", nullable: false },
            Column { name: "advances", pg_type: "int8", nullable: false },
            Column { name: "training_days", pg_type: "numeric", nullable: true },
            Column { name: "personal_income_tax", pg_type: "int8", nullable: false },
            Column { name: "notes", pg_type: "text", nullable: true },
            Column { name: "status", pg_type: "text", nullable: false },
            Column { name: "tl_approved_by", pg_type: "int4", nullable: true },
            Column { name: "tl_approved_at", pg_type: "timestamptz", nullable: true },
            Column { name: "approved_by", pg_type: "int4", nullable: true },
            Column { name: "approved_at", pg_type: "timestamptz", nullable: true },
            Column { name: "deleted_at", pg_type: "timestamptz", nullable: true },
            Column { name: "deleted_by", pg_type: "int4", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `NotificationTemplate`, bảng `notification_templates`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct NotificationTemplate {
    pub id: i32,
    pub name: String,
    pub event_type: Option<String>,
    pub channel: String,
    pub subject: Option<String>,
    pub body: String,
    pub recipients_rule: Option<JsonValue>,
    pub is_active: bool,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for NotificationTemplate {
    const INFO: ModelInfo = ModelInfo {
        name: "NotificationTemplate",
        table: "notification_templates",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "name", pg_type: "text", nullable: false },
            Column { name: "event_type", pg_type: "text", nullable: true },
            Column { name: "channel", pg_type: "text", nullable: false },
            Column { name: "subject", pg_type: "text", nullable: true },
            Column { name: "body", pg_type: "text", nullable: false },
            Column { name: "recipients_rule", pg_type: "jsonb", nullable: true },
            Column { name: "is_active", pg_type: "bool", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `NotificationLog`, bảng `notification_logs`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct NotificationLog {
    pub id: i32,
    pub recipient_id: i32,
    pub template_id: Option<i32>,
    pub event_type: Option<String>,
    pub channel: String,
    pub title: Option<String>,
    pub body: Option<String>,
    pub status: String,
    pub retry_count: i32,
    pub is_read: bool,
    pub read_at: Option<Timestamp>,
    pub error: Option<String>,
    pub scheduled_at: Option<Timestamp>,
    pub action_url: Option<String>,
    pub sent_at: Option<Timestamp>,
    pub webhook_url: Option<String>,
    pub claimed_at: Option<Timestamp>,
    pub created_at: Timestamp,
}

impl Model for NotificationLog {
    const INFO: ModelInfo = ModelInfo {
        name: "NotificationLog",
        table: "notification_logs",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "recipient_id", pg_type: "int4", nullable: false },
            Column { name: "template_id", pg_type: "int4", nullable: true },
            Column { name: "event_type", pg_type: "text", nullable: true },
            Column { name: "channel", pg_type: "text", nullable: false },
            Column { name: "title", pg_type: "text", nullable: true },
            Column { name: "body", pg_type: "text", nullable: true },
            Column { name: "status", pg_type: "text", nullable: false },
            Column { name: "retry_count", pg_type: "int4", nullable: false },
            Column { name: "is_read", pg_type: "bool", nullable: false },
            Column { name: "read_at", pg_type: "timestamptz", nullable: true },
            Column { name: "error", pg_type: "text", nullable: true },
            Column { name: "scheduled_at", pg_type: "timestamptz", nullable: true },
            Column { name: "action_url", pg_type: "text", nullable: true },
            Column { name: "sent_at", pg_type: "timestamptz", nullable: true },
            Column { name: "webhook_url", pg_type: "text", nullable: true },
            Column { name: "claimed_at", pg_type: "timestamptz", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `RevokedSession`, bảng `revoked_sessions`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct RevokedSession {
    pub session_id: String,
    pub user_id: i32,
    pub expires_at: Timestamp,
    pub created_at: Timestamp,
}

impl Model for RevokedSession {
    const INFO: ModelInfo = ModelInfo {
        name: "RevokedSession",
        table: "revoked_sessions",
        columns: &[
            Column { name: "session_id", pg_type: "varchar", nullable: false },
            Column { name: "user_id", pg_type: "int4", nullable: false },
            Column { name: "expires_at", pg_type: "timestamptz", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `UserInvitation`, bảng `user_invitations`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct UserInvitation {
    pub id: i32,
    pub email: String,
    pub role_id: Option<i32>,
    pub token_hash: String,
    pub expires_at: Timestamp,
    pub accepted_at: Option<Timestamp>,
    pub accepted_user_id: Option<i32>,
    pub revoked_at: Option<Timestamp>,
    pub created_by: Option<i32>,
    pub created_at: Timestamp,
}

impl Model for UserInvitation {
    const INFO: ModelInfo = ModelInfo {
        name: "UserInvitation",
        table: "user_invitations",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "email", pg_type: "varchar", nullable: false },
            Column { name: "role_id", pg_type: "int4", nullable: true },
            Column { name: "token_hash", pg_type: "varchar", nullable: false },
            Column { name: "expires_at", pg_type: "timestamptz", nullable: false },
            Column { name: "accepted_at", pg_type: "timestamptz", nullable: true },
            Column { name: "accepted_user_id", pg_type: "int4", nullable: true },
            Column { name: "revoked_at", pg_type: "timestamptz", nullable: true },
            Column { name: "created_by", pg_type: "int4", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `Setting`, bảng `settings`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct Setting {
    pub key: String,
    pub value: String,
    pub updated_at: Timestamp,
    pub updated_by: Option<i32>,
}

impl Model for Setting {
    const INFO: ModelInfo = ModelInfo {
        name: "Setting",
        table: "settings",
        columns: &[
            Column { name: "key", pg_type: "text", nullable: false },
            Column { name: "value", pg_type: "text", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_by", pg_type: "int4", nullable: true },
        ],
    };
}

/// Model `LeadAiIntent`, bảng `lead_ai_intents`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct LeadAiIntent {
    pub contact_id: i32,
    pub intent: JsNumber,
    pub reason: Option<String>,
    pub client_id: Option<String>,
    pub user_id: Option<i32>,
    pub updated_at: Timestamp,
}

impl Model for LeadAiIntent {
    const INFO: ModelInfo = ModelInfo {
        name: "LeadAiIntent",
        table: "lead_ai_intents",
        columns: &[
            Column { name: "contact_id", pg_type: "int4", nullable: false },
            Column { name: "intent", pg_type: "float8", nullable: false },
            Column { name: "reason", pg_type: "varchar", nullable: true },
            Column { name: "client_id", pg_type: "varchar", nullable: true },
            Column { name: "user_id", pg_type: "int4", nullable: true },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `SettingOption`, bảng `setting_options`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct SettingOption {
    pub id: i32,
    pub group_key: String,
    pub value: String,
    pub label: String,
    pub sort_order: i32,
    pub is_active: bool,
    pub is_system: bool,
    pub metadata: Option<JsonValue>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub updated_by: Option<i32>,
}

impl Model for SettingOption {
    const INFO: ModelInfo = ModelInfo {
        name: "SettingOption",
        table: "setting_options",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "group_key", pg_type: "text", nullable: false },
            Column { name: "value", pg_type: "text", nullable: false },
            Column { name: "label", pg_type: "text", nullable: false },
            Column { name: "sort_order", pg_type: "int4", nullable: false },
            Column { name: "is_active", pg_type: "bool", nullable: false },
            Column { name: "is_system", pg_type: "bool", nullable: false },
            Column { name: "metadata", pg_type: "jsonb", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_by", pg_type: "int4", nullable: true },
        ],
    };
}

/// Model `AuditLog`, bảng `audit_logs`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct AuditLog {
    pub id: i32,
    pub user_id: Option<i32>,
    pub action: String,
    pub resource: String,
    pub resource_id: Option<i32>,
    pub metadata: Option<JsonValue>,
    pub ip_address: Option<String>,
    pub created_at: Timestamp,
}

impl Model for AuditLog {
    const INFO: ModelInfo = ModelInfo {
        name: "AuditLog",
        table: "audit_logs",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "user_id", pg_type: "int4", nullable: true },
            Column { name: "action", pg_type: "text", nullable: false },
            Column { name: "resource", pg_type: "text", nullable: false },
            Column { name: "resource_id", pg_type: "int4", nullable: true },
            Column { name: "metadata", pg_type: "jsonb", nullable: true },
            Column { name: "ip_address", pg_type: "text", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `ApiKey`, bảng `api_keys`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct ApiKey {
    pub id: i32,
    pub name: String,
    pub prefix: String,
    pub key_hash: String,
    pub scopes: PgList<String>,
    pub owner_user_id: i32,
    pub created_by: i32,
    pub last_used_at: Option<Timestamp>,
    pub last_used_ip: Option<String>,
    pub expires_at: Option<Timestamp>,
    pub revoked_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for ApiKey {
    const INFO: ModelInfo = ModelInfo {
        name: "ApiKey",
        table: "api_keys",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "name", pg_type: "varchar", nullable: false },
            Column { name: "prefix", pg_type: "varchar", nullable: false },
            Column { name: "key_hash", pg_type: "varchar", nullable: false },
            Column { name: "scopes", pg_type: "_text", nullable: true },
            Column { name: "owner_user_id", pg_type: "int4", nullable: false },
            Column { name: "created_by", pg_type: "int4", nullable: false },
            Column { name: "last_used_at", pg_type: "timestamptz", nullable: true },
            Column { name: "last_used_ip", pg_type: "text", nullable: true },
            Column { name: "expires_at", pg_type: "timestamptz", nullable: true },
            Column { name: "revoked_at", pg_type: "timestamptz", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `NewsfeedPost`, bảng `newsfeed_posts`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct NewsfeedPost {
    pub id: i32,
    pub category: String,
    pub author_id: i32,
    pub content: String,
    pub image_url: Option<String>,
    pub edited_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for NewsfeedPost {
    const INFO: ModelInfo = ModelInfo {
        name: "NewsfeedPost",
        table: "newsfeed_posts",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "category", pg_type: "text", nullable: false },
            Column { name: "author_id", pg_type: "int4", nullable: false },
            Column { name: "content", pg_type: "text", nullable: false },
            Column { name: "image_url", pg_type: "text", nullable: true },
            Column { name: "edited_at", pg_type: "timestamptz", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `NewsfeedPostImage`, bảng `newsfeed_post_images`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct NewsfeedPostImage {
    pub id: i32,
    pub post_id: i32,
    pub image_url: String,
    pub media_type: NewsfeedMediaType,
    pub sort_order: i32,
    pub created_at: Timestamp,
}

impl Model for NewsfeedPostImage {
    const INFO: ModelInfo = ModelInfo {
        name: "NewsfeedPostImage",
        table: "newsfeed_post_images",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "post_id", pg_type: "int4", nullable: false },
            Column { name: "image_url", pg_type: "text", nullable: false },
            Column { name: "media_type", pg_type: "NewsfeedMediaType", nullable: false },
            Column { name: "sort_order", pg_type: "int4", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `NewsfeedPostLike`, bảng `newsfeed_post_likes`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct NewsfeedPostLike {
    pub id: i32,
    pub post_id: i32,
    pub user_id: i32,
    pub created_at: Timestamp,
}

impl Model for NewsfeedPostLike {
    const INFO: ModelInfo = ModelInfo {
        name: "NewsfeedPostLike",
        table: "newsfeed_post_likes",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "post_id", pg_type: "int4", nullable: false },
            Column { name: "user_id", pg_type: "int4", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `NewsfeedPostComment`, bảng `newsfeed_post_comments`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct NewsfeedPostComment {
    pub id: i32,
    pub post_id: i32,
    pub user_id: i32,
    pub content: String,
    pub created_at: Timestamp,
}

impl Model for NewsfeedPostComment {
    const INFO: ModelInfo = ModelInfo {
        name: "NewsfeedPostComment",
        table: "newsfeed_post_comments",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "post_id", pg_type: "int4", nullable: false },
            Column { name: "user_id", pg_type: "int4", nullable: false },
            Column { name: "content", pg_type: "text", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `AttendanceOffice`, bảng `attendance_offices`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct AttendanceOffice {
    pub id: i32,
    pub name: String,
    pub description: Option<String>,
    pub ips: PgList<String>,
    pub is_active: bool,
    pub is_demo: bool,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for AttendanceOffice {
    const INFO: ModelInfo = ModelInfo {
        name: "AttendanceOffice",
        table: "attendance_offices",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "name", pg_type: "text", nullable: false },
            Column { name: "description", pg_type: "text", nullable: true },
            Column { name: "ips", pg_type: "_text", nullable: true },
            Column { name: "is_active", pg_type: "bool", nullable: false },
            Column { name: "is_demo", pg_type: "bool", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `AttendanceQrSession`, bảng `attendance_qr_sessions`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct AttendanceQrSession {
    pub id: i32,
    pub token: String,
    pub created_by: i32,
    pub created_at: Timestamp,
    pub expires_at: Timestamp,
    pub is_active: bool,
}

impl Model for AttendanceQrSession {
    const INFO: ModelInfo = ModelInfo {
        name: "AttendanceQrSession",
        table: "attendance_qr_sessions",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "token", pg_type: "text", nullable: false },
            Column { name: "created_by", pg_type: "int4", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "expires_at", pg_type: "timestamptz", nullable: false },
            Column { name: "is_active", pg_type: "bool", nullable: false },
        ],
    };
}

/// Model `AttendanceRecord`, bảng `attendance_records`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct AttendanceRecord {
    pub id: i32,
    pub user_id: i32,
    pub employee_id: Option<i32>,
    pub work_date: DbDate,
    pub check_in_at: Option<Timestamp>,
    pub check_out_at: Option<Timestamp>,
    pub check_in_proof_key: Option<String>,
    pub check_out_proof_key: Option<String>,
    pub check_in_lat: Option<JsNumber>,
    pub check_in_lng: Option<JsNumber>,
    pub check_out_lat: Option<JsNumber>,
    pub check_out_lng: Option<JsNumber>,
    pub check_in_note: Option<String>,
    pub check_out_note: Option<String>,
    pub total_hours: Option<JsNumber>,
    pub overtime_hours: Option<JsNumber>,
    pub late_minutes: Option<i32>,
    pub status: String,
    pub check_in_ip: Option<String>,
    pub check_out_ip: Option<String>,
    pub check_in_office_id: Option<i32>,
    pub check_out_office_id: Option<i32>,
    pub device_id: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for AttendanceRecord {
    const INFO: ModelInfo = ModelInfo {
        name: "AttendanceRecord",
        table: "attendance_records",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "user_id", pg_type: "int4", nullable: false },
            Column { name: "employee_id", pg_type: "int4", nullable: true },
            Column { name: "work_date", pg_type: "date", nullable: false },
            Column { name: "check_in_at", pg_type: "timestamptz", nullable: true },
            Column { name: "check_out_at", pg_type: "timestamptz", nullable: true },
            Column { name: "check_in_proof_key", pg_type: "text", nullable: true },
            Column { name: "check_out_proof_key", pg_type: "text", nullable: true },
            Column { name: "check_in_lat", pg_type: "float8", nullable: true },
            Column { name: "check_in_lng", pg_type: "float8", nullable: true },
            Column { name: "check_out_lat", pg_type: "float8", nullable: true },
            Column { name: "check_out_lng", pg_type: "float8", nullable: true },
            Column { name: "check_in_note", pg_type: "text", nullable: true },
            Column { name: "check_out_note", pg_type: "text", nullable: true },
            Column { name: "total_hours", pg_type: "float8", nullable: true },
            Column { name: "overtime_hours", pg_type: "float8", nullable: true },
            Column { name: "late_minutes", pg_type: "int4", nullable: true },
            Column { name: "status", pg_type: "text", nullable: false },
            Column { name: "check_in_ip", pg_type: "text", nullable: true },
            Column { name: "check_out_ip", pg_type: "text", nullable: true },
            Column { name: "check_in_office_id", pg_type: "int4", nullable: true },
            Column { name: "check_out_office_id", pg_type: "int4", nullable: true },
            Column { name: "device_id", pg_type: "text", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `AttendanceRequest`, bảng `attendance_requests`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct AttendanceRequest {
    pub id: i32,
    pub user_id: i32,
    pub work_date: DbDate,
    #[sqlx(rename = "type")]
    pub r#type: String,
    pub requested_check_in: Option<String>,
    pub requested_check_out: Option<String>,
    pub reason: String,
    pub status: String,
    pub reviewed_by: Option<i32>,
    pub reviewed_at: Option<Timestamp>,
    pub review_note: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for AttendanceRequest {
    const INFO: ModelInfo = ModelInfo {
        name: "AttendanceRequest",
        table: "attendance_requests",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "user_id", pg_type: "int4", nullable: false },
            Column { name: "work_date", pg_type: "date", nullable: false },
            Column { name: "type", pg_type: "text", nullable: false },
            Column { name: "requested_check_in", pg_type: "text", nullable: true },
            Column { name: "requested_check_out", pg_type: "text", nullable: true },
            Column { name: "reason", pg_type: "text", nullable: false },
            Column { name: "status", pg_type: "text", nullable: false },
            Column { name: "reviewed_by", pg_type: "int4", nullable: true },
            Column { name: "reviewed_at", pg_type: "timestamptz", nullable: true },
            Column { name: "review_note", pg_type: "text", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `Product`, bảng `products`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct Product {
    pub id: i32,
    pub code: String,
    pub name: String,
    pub project_id: Option<i32>,
    pub brand: Option<String>,
    pub color: Option<String>,
    pub tags: PgList<String>,
    pub is_featured: bool,
    pub image_url: Option<String>,
    pub category_id: Option<i32>,
    pub attributes: JsonValue,
    pub description: Option<String>,
    pub price: Option<JsBigInt>,
    pub is_active: bool,
    pub deleted_at: Option<Timestamp>,
    pub deleted_by: Option<i32>,
    pub created_by: Option<i32>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for Product {
    const INFO: ModelInfo = ModelInfo {
        name: "Product",
        table: "products",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "code", pg_type: "varchar", nullable: false },
            Column { name: "name", pg_type: "varchar", nullable: false },
            Column { name: "project_id", pg_type: "int4", nullable: true },
            Column { name: "brand", pg_type: "varchar", nullable: true },
            Column { name: "color", pg_type: "varchar", nullable: true },
            Column { name: "tags", pg_type: "_text", nullable: true },
            Column { name: "is_featured", pg_type: "bool", nullable: false },
            Column { name: "image_url", pg_type: "text", nullable: true },
            Column { name: "category_id", pg_type: "int4", nullable: true },
            Column { name: "attributes", pg_type: "jsonb", nullable: false },
            Column { name: "description", pg_type: "text", nullable: true },
            Column { name: "price", pg_type: "int8", nullable: true },
            Column { name: "is_active", pg_type: "bool", nullable: false },
            Column { name: "deleted_at", pg_type: "timestamptz", nullable: true },
            Column { name: "deleted_by", pg_type: "int4", nullable: true },
            Column { name: "created_by", pg_type: "int4", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `ProductCategory`, bảng `product_categories`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct ProductCategory {
    pub id: i32,
    pub code: String,
    pub name: String,
    pub description: Option<String>,
    pub is_active: bool,
    pub sort_order: i32,
    pub created_by: Option<i32>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for ProductCategory {
    const INFO: ModelInfo = ModelInfo {
        name: "ProductCategory",
        table: "product_categories",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "code", pg_type: "varchar", nullable: false },
            Column { name: "name", pg_type: "varchar", nullable: false },
            Column { name: "description", pg_type: "text", nullable: true },
            Column { name: "is_active", pg_type: "bool", nullable: false },
            Column { name: "sort_order", pg_type: "int4", nullable: false },
            Column { name: "created_by", pg_type: "int4", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `ProductAttributeDef`, bảng `product_attribute_defs`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct ProductAttributeDef {
    pub id: i32,
    pub category_id: i32,
    pub key: String,
    pub label: String,
    #[sqlx(rename = "type")]
    pub r#type: String,
    pub options: Option<JsonValue>,
    pub is_required: bool,
    pub sort_order: i32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for ProductAttributeDef {
    const INFO: ModelInfo = ModelInfo {
        name: "ProductAttributeDef",
        table: "product_attribute_defs",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "category_id", pg_type: "int4", nullable: false },
            Column { name: "key", pg_type: "varchar", nullable: false },
            Column { name: "label", pg_type: "varchar", nullable: false },
            Column { name: "type", pg_type: "varchar", nullable: false },
            Column { name: "options", pg_type: "jsonb", nullable: true },
            Column { name: "is_required", pg_type: "bool", nullable: false },
            Column { name: "sort_order", pg_type: "int4", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `KanbanBoard`, bảng `kanban_boards`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct KanbanBoard {
    pub id: i32,
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub is_active: bool,
    pub visibility_role_ids: PgList<i32>,
    pub card_prefix: Option<String>,
    pub settings: JsonValue,
    pub label_defs: JsonValue,
    pub created_by: Option<i32>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub deleted_at: Option<Timestamp>,
}

impl Model for KanbanBoard {
    const INFO: ModelInfo = ModelInfo {
        name: "KanbanBoard",
        table: "kanban_boards",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "name", pg_type: "varchar", nullable: false },
            Column { name: "description", pg_type: "text", nullable: true },
            Column { name: "icon", pg_type: "varchar", nullable: true },
            Column { name: "color", pg_type: "varchar", nullable: true },
            Column { name: "is_active", pg_type: "bool", nullable: false },
            Column { name: "visibility_role_ids", pg_type: "_int4", nullable: true },
            Column { name: "card_prefix", pg_type: "varchar", nullable: true },
            Column { name: "settings", pg_type: "jsonb", nullable: false },
            Column { name: "label_defs", pg_type: "jsonb", nullable: false },
            Column { name: "created_by", pg_type: "int4", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
            Column { name: "deleted_at", pg_type: "timestamptz", nullable: true },
        ],
    };
}

/// Model `KanbanColumn`, bảng `kanban_columns`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct KanbanColumn {
    pub id: i32,
    pub board_id: i32,
    pub name: String,
    pub color: Option<String>,
    pub position: JsNumber,
    pub wip_limit: Option<i32>,
    pub is_done: bool,
    pub is_archived: bool,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for KanbanColumn {
    const INFO: ModelInfo = ModelInfo {
        name: "KanbanColumn",
        table: "kanban_columns",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "board_id", pg_type: "int4", nullable: false },
            Column { name: "name", pg_type: "varchar", nullable: false },
            Column { name: "color", pg_type: "varchar", nullable: true },
            Column { name: "position", pg_type: "float8", nullable: false },
            Column { name: "wip_limit", pg_type: "int4", nullable: true },
            Column { name: "is_done", pg_type: "bool", nullable: false },
            Column { name: "is_archived", pg_type: "bool", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `KanbanFieldDef`, bảng `kanban_field_defs`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct KanbanFieldDef {
    pub id: i32,
    pub board_id: i32,
    pub key: String,
    pub label: String,
    #[sqlx(rename = "type")]
    pub r#type: String,
    pub options: Option<JsonValue>,
    pub required: bool,
    pub show_on_card: bool,
    pub position: JsNumber,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for KanbanFieldDef {
    const INFO: ModelInfo = ModelInfo {
        name: "KanbanFieldDef",
        table: "kanban_field_defs",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "board_id", pg_type: "int4", nullable: false },
            Column { name: "key", pg_type: "varchar", nullable: false },
            Column { name: "label", pg_type: "varchar", nullable: false },
            Column { name: "type", pg_type: "varchar", nullable: false },
            Column { name: "options", pg_type: "jsonb", nullable: true },
            Column { name: "required", pg_type: "bool", nullable: false },
            Column { name: "show_on_card", pg_type: "bool", nullable: false },
            Column { name: "position", pg_type: "float8", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `KanbanCard`, bảng `kanban_cards`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct KanbanCard {
    pub id: i32,
    pub code: Option<String>,
    pub board_id: i32,
    pub column_id: i32,
    pub position: JsNumber,
    pub title: String,
    pub description: Option<String>,
    pub contact_id: Option<i32>,
    pub assignee_id: Option<i32>,
    pub created_by: i32,
    pub due_at: Option<Timestamp>,
    pub priority: Option<String>,
    pub labels: PgList<String>,
    pub attributes: JsonValue,
    pub completed_at: Option<Timestamp>,
    pub due_completed_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub deleted_at: Option<Timestamp>,
    pub deleted_by: Option<i32>,
}

impl Model for KanbanCard {
    const INFO: ModelInfo = ModelInfo {
        name: "KanbanCard",
        table: "kanban_cards",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "code", pg_type: "varchar", nullable: true },
            Column { name: "board_id", pg_type: "int4", nullable: false },
            Column { name: "column_id", pg_type: "int4", nullable: false },
            Column { name: "position", pg_type: "float8", nullable: false },
            Column { name: "title", pg_type: "varchar", nullable: false },
            Column { name: "description", pg_type: "text", nullable: true },
            Column { name: "contact_id", pg_type: "int4", nullable: true },
            Column { name: "assignee_id", pg_type: "int4", nullable: true },
            Column { name: "created_by", pg_type: "int4", nullable: false },
            Column { name: "due_at", pg_type: "timestamptz", nullable: true },
            Column { name: "priority", pg_type: "varchar", nullable: true },
            Column { name: "labels", pg_type: "_text", nullable: true },
            Column { name: "attributes", pg_type: "jsonb", nullable: false },
            Column { name: "completed_at", pg_type: "timestamptz", nullable: true },
            Column { name: "due_completed_at", pg_type: "timestamptz", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
            Column { name: "deleted_at", pg_type: "timestamptz", nullable: true },
            Column { name: "deleted_by", pg_type: "int4", nullable: true },
        ],
    };
}

/// Model `KanbanCardAssignee`, bảng `kanban_card_assignees`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct KanbanCardAssignee {
    pub id: i32,
    pub card_id: i32,
    pub user_id: i32,
    pub created_at: Timestamp,
}

impl Model for KanbanCardAssignee {
    const INFO: ModelInfo = ModelInfo {
        name: "KanbanCardAssignee",
        table: "kanban_card_assignees",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "card_id", pg_type: "int4", nullable: false },
            Column { name: "user_id", pg_type: "int4", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `KanbanChecklistItem`, bảng `kanban_checklist_items`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct KanbanChecklistItem {
    pub id: i32,
    pub card_id: i32,
    pub text: String,
    pub is_done: bool,
    pub position: JsNumber,
    pub created_by: Option<i32>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for KanbanChecklistItem {
    const INFO: ModelInfo = ModelInfo {
        name: "KanbanChecklistItem",
        table: "kanban_checklist_items",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "card_id", pg_type: "int4", nullable: false },
            Column { name: "text", pg_type: "varchar", nullable: false },
            Column { name: "is_done", pg_type: "bool", nullable: false },
            Column { name: "position", pg_type: "float8", nullable: false },
            Column { name: "created_by", pg_type: "int4", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `KanbanCardAttachment`, bảng `kanban_card_attachments`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct KanbanCardAttachment {
    pub id: i32,
    pub card_id: i32,
    pub url: String,
    pub title: Option<String>,
    pub created_by: i32,
    pub created_at: Timestamp,
}

impl Model for KanbanCardAttachment {
    const INFO: ModelInfo = ModelInfo {
        name: "KanbanCardAttachment",
        table: "kanban_card_attachments",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "card_id", pg_type: "int4", nullable: false },
            Column { name: "url", pg_type: "text", nullable: false },
            Column { name: "title", pg_type: "varchar", nullable: true },
            Column { name: "created_by", pg_type: "int4", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `KanbanCardActivity`, bảng `kanban_card_activities`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct KanbanCardActivity {
    pub id: i32,
    pub card_id: i32,
    pub actor_id: Option<i32>,
    pub action: String,
    pub payload: JsonValue,
    pub created_at: Timestamp,
}

impl Model for KanbanCardActivity {
    const INFO: ModelInfo = ModelInfo {
        name: "KanbanCardActivity",
        table: "kanban_card_activities",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "card_id", pg_type: "int4", nullable: false },
            Column { name: "actor_id", pg_type: "int4", nullable: true },
            Column { name: "action", pg_type: "varchar", nullable: false },
            Column { name: "payload", pg_type: "jsonb", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `PosSettings`, bảng `pos_settings`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct PosSettings {
    pub id: i32,
    pub store_name: String,
    pub address: Option<String>,
    pub phone: Option<String>,
    pub receipt_footer: Option<String>,
    pub bank_bin: Option<String>,
    pub bank_account_no: Option<String>,
    pub bank_account_name: Option<String>,
    pub menu_category_ids: PgList<i32>,
    pub updated_at: Timestamp,
}

impl Model for PosSettings {
    const INFO: ModelInfo = ModelInfo {
        name: "PosSettings",
        table: "pos_settings",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "store_name", pg_type: "varchar", nullable: false },
            Column { name: "address", pg_type: "varchar", nullable: true },
            Column { name: "phone", pg_type: "varchar", nullable: true },
            Column { name: "receipt_footer", pg_type: "varchar", nullable: true },
            Column { name: "bank_bin", pg_type: "varchar", nullable: true },
            Column { name: "bank_account_no", pg_type: "varchar", nullable: true },
            Column { name: "bank_account_name", pg_type: "varchar", nullable: true },
            Column { name: "menu_category_ids", pg_type: "_int4", nullable: true },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `PosArea`, bảng `pos_areas`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct PosArea {
    pub id: i32,
    pub name: String,
    pub sort_order: i32,
    pub is_active: bool,
    pub created_at: Timestamp,
}

impl Model for PosArea {
    const INFO: ModelInfo = ModelInfo {
        name: "PosArea",
        table: "pos_areas",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "name", pg_type: "varchar", nullable: false },
            Column { name: "sort_order", pg_type: "int4", nullable: false },
            Column { name: "is_active", pg_type: "bool", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `PosTable`, bảng `pos_tables`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct PosTable {
    pub id: i32,
    pub area_id: i32,
    pub name: String,
    pub sort_order: i32,
    pub is_active: bool,
    pub created_at: Timestamp,
}

impl Model for PosTable {
    const INFO: ModelInfo = ModelInfo {
        name: "PosTable",
        table: "pos_tables",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "area_id", pg_type: "int4", nullable: false },
            Column { name: "name", pg_type: "varchar", nullable: false },
            Column { name: "sort_order", pg_type: "int4", nullable: false },
            Column { name: "is_active", pg_type: "bool", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `PosModifier`, bảng `pos_modifiers`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct PosModifier {
    pub id: i32,
    pub group_name: String,
    pub name: String,
    pub price_delta: JsBigInt,
    pub sort_order: i32,
    pub is_active: bool,
    pub created_at: Timestamp,
}

impl Model for PosModifier {
    const INFO: ModelInfo = ModelInfo {
        name: "PosModifier",
        table: "pos_modifiers",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "group_name", pg_type: "varchar", nullable: false },
            Column { name: "name", pg_type: "varchar", nullable: false },
            Column { name: "price_delta", pg_type: "int8", nullable: false },
            Column { name: "sort_order", pg_type: "int4", nullable: false },
            Column { name: "is_active", pg_type: "bool", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `PosShift`, bảng `pos_shifts`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct PosShift {
    pub id: i32,
    pub opened_by: i32,
    pub opened_at: Timestamp,
    pub opening_cash: JsBigInt,
    pub status: String,
    pub closed_by: Option<i32>,
    pub closed_at: Option<Timestamp>,
    pub closing_cash_counted: Option<JsBigInt>,
    pub expected_cash: Option<JsBigInt>,
    pub cash_diff: Option<JsBigInt>,
    pub note: Option<String>,
}

impl Model for PosShift {
    const INFO: ModelInfo = ModelInfo {
        name: "PosShift",
        table: "pos_shifts",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "opened_by", pg_type: "int4", nullable: false },
            Column { name: "opened_at", pg_type: "timestamptz", nullable: false },
            Column { name: "opening_cash", pg_type: "int8", nullable: false },
            Column { name: "status", pg_type: "varchar", nullable: false },
            Column { name: "closed_by", pg_type: "int4", nullable: true },
            Column { name: "closed_at", pg_type: "timestamptz", nullable: true },
            Column { name: "closing_cash_counted", pg_type: "int8", nullable: true },
            Column { name: "expected_cash", pg_type: "int8", nullable: true },
            Column { name: "cash_diff", pg_type: "int8", nullable: true },
            Column { name: "note", pg_type: "varchar", nullable: true },
        ],
    };
}

/// Model `PosOrder`, bảng `pos_orders`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct PosOrder {
    pub id: i32,
    pub code: String,
    pub shift_id: i32,
    pub table_id: Option<i32>,
    pub order_type: String,
    pub status: String,
    pub note: Option<String>,
    pub subtotal: JsBigInt,
    pub discount_type: String,
    pub discount_value: JsBigInt,
    pub discount_amount: JsBigInt,
    pub total: JsBigInt,
    pub created_by: i32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub paid_by: Option<i32>,
    pub paid_at: Option<Timestamp>,
    pub voided_by: Option<i32>,
    pub voided_at: Option<Timestamp>,
    pub void_reason: Option<String>,
}

impl Model for PosOrder {
    const INFO: ModelInfo = ModelInfo {
        name: "PosOrder",
        table: "pos_orders",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "code", pg_type: "varchar", nullable: false },
            Column { name: "shift_id", pg_type: "int4", nullable: false },
            Column { name: "table_id", pg_type: "int4", nullable: true },
            Column { name: "order_type", pg_type: "varchar", nullable: false },
            Column { name: "status", pg_type: "varchar", nullable: false },
            Column { name: "note", pg_type: "varchar", nullable: true },
            Column { name: "subtotal", pg_type: "int8", nullable: false },
            Column { name: "discount_type", pg_type: "varchar", nullable: false },
            Column { name: "discount_value", pg_type: "int8", nullable: false },
            Column { name: "discount_amount", pg_type: "int8", nullable: false },
            Column { name: "total", pg_type: "int8", nullable: false },
            Column { name: "created_by", pg_type: "int4", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
            Column { name: "paid_by", pg_type: "int4", nullable: true },
            Column { name: "paid_at", pg_type: "timestamptz", nullable: true },
            Column { name: "voided_by", pg_type: "int4", nullable: true },
            Column { name: "voided_at", pg_type: "timestamptz", nullable: true },
            Column { name: "void_reason", pg_type: "varchar", nullable: true },
        ],
    };
}

/// Model `PosOrderItem`, bảng `pos_order_items`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct PosOrderItem {
    pub id: i32,
    pub order_id: i32,
    pub product_id: i32,
    pub product_name: String,
    pub unit_price: JsBigInt,
    pub quantity: i32,
    pub options: JsonValue,
    pub note: Option<String>,
    pub line_total: JsBigInt,
    pub created_at: Timestamp,
}

impl Model for PosOrderItem {
    const INFO: ModelInfo = ModelInfo {
        name: "PosOrderItem",
        table: "pos_order_items",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "order_id", pg_type: "int4", nullable: false },
            Column { name: "product_id", pg_type: "int4", nullable: false },
            Column { name: "product_name", pg_type: "varchar", nullable: false },
            Column { name: "unit_price", pg_type: "int8", nullable: false },
            Column { name: "quantity", pg_type: "int4", nullable: false },
            Column { name: "options", pg_type: "jsonb", nullable: false },
            Column { name: "note", pg_type: "varchar", nullable: true },
            Column { name: "line_total", pg_type: "int8", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `PosPayment`, bảng `pos_payments`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct PosPayment {
    pub id: i32,
    pub order_id: i32,
    pub shift_id: i32,
    pub method: String,
    pub amount: JsBigInt,
    pub tendered: Option<JsBigInt>,
    pub change: JsBigInt,
    pub reference: Option<String>,
    pub created_by: i32,
    pub created_at: Timestamp,
}

impl Model for PosPayment {
    const INFO: ModelInfo = ModelInfo {
        name: "PosPayment",
        table: "pos_payments",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "order_id", pg_type: "int4", nullable: false },
            Column { name: "shift_id", pg_type: "int4", nullable: false },
            Column { name: "method", pg_type: "varchar", nullable: false },
            Column { name: "amount", pg_type: "int8", nullable: false },
            Column { name: "tendered", pg_type: "int8", nullable: true },
            Column { name: "change", pg_type: "int8", nullable: false },
            Column { name: "reference", pg_type: "varchar", nullable: true },
            Column { name: "created_by", pg_type: "int4", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `IntegrationAuditLog`, bảng `integration_audit_logs`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct IntegrationAuditLog {
    pub id: JsBigInt,
    pub created_at: Timestamp,
    pub channel: String,
    pub client_id: Option<String>,
    pub user_id: Option<i32>,
    pub action: String,
    pub resource: Option<String>,
    pub resource_id: Option<String>,
    pub status: String,
    pub http_status: Option<i32>,
    pub duration_ms: Option<i32>,
    pub error: Option<String>,
    pub metadata: JsonValue,
}

impl Model for IntegrationAuditLog {
    const INFO: ModelInfo = ModelInfo {
        name: "IntegrationAuditLog",
        table: "integration_audit_logs",
        columns: &[
            Column { name: "id", pg_type: "int8", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "channel", pg_type: "varchar", nullable: false },
            Column { name: "client_id", pg_type: "varchar", nullable: true },
            Column { name: "user_id", pg_type: "int4", nullable: true },
            Column { name: "action", pg_type: "varchar", nullable: false },
            Column { name: "resource", pg_type: "varchar", nullable: true },
            Column { name: "resource_id", pg_type: "varchar", nullable: true },
            Column { name: "status", pg_type: "varchar", nullable: false },
            Column { name: "http_status", pg_type: "int4", nullable: true },
            Column { name: "duration_ms", pg_type: "int4", nullable: true },
            Column { name: "error", pg_type: "varchar", nullable: true },
            Column { name: "metadata", pg_type: "jsonb", nullable: false },
        ],
    };
}

/// Model `IntegrationEvent`, bảng `integration_events`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct IntegrationEvent {
    pub id: JsBigInt,
    pub event_type: String,
    pub resource: String,
    pub resource_id: String,
    pub payload: JsonValue,
    pub actor_user_id: Option<i32>,
    pub created_at: Timestamp,
    pub dispatched_at: Option<Timestamp>,
}

impl Model for IntegrationEvent {
    const INFO: ModelInfo = ModelInfo {
        name: "IntegrationEvent",
        table: "integration_events",
        columns: &[
            Column { name: "id", pg_type: "int8", nullable: false },
            Column { name: "event_type", pg_type: "varchar", nullable: false },
            Column { name: "resource", pg_type: "varchar", nullable: false },
            Column { name: "resource_id", pg_type: "varchar", nullable: false },
            Column { name: "payload", pg_type: "jsonb", nullable: false },
            Column { name: "actor_user_id", pg_type: "int4", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "dispatched_at", pg_type: "timestamptz", nullable: true },
        ],
    };
}

/// Model `WebhookEndpoint`, bảng `webhook_endpoints`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct WebhookEndpoint {
    pub id: i32,
    pub name: String,
    pub url: String,
    pub secret_enc: String,
    pub events: PgList<String>,
    pub is_active: bool,
    pub disabled_reason: Option<String>,
    pub created_by: i32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub last_success_at: Option<Timestamp>,
    pub last_failure_at: Option<Timestamp>,
    pub consecutive_failures: i32,
}

impl Model for WebhookEndpoint {
    const INFO: ModelInfo = ModelInfo {
        name: "WebhookEndpoint",
        table: "webhook_endpoints",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "name", pg_type: "varchar", nullable: false },
            Column { name: "url", pg_type: "varchar", nullable: false },
            Column { name: "secret_enc", pg_type: "text", nullable: false },
            Column { name: "events", pg_type: "_text", nullable: true },
            Column { name: "is_active", pg_type: "bool", nullable: false },
            Column { name: "disabled_reason", pg_type: "varchar", nullable: true },
            Column { name: "created_by", pg_type: "int4", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
            Column { name: "last_success_at", pg_type: "timestamptz", nullable: true },
            Column { name: "last_failure_at", pg_type: "timestamptz", nullable: true },
            Column { name: "consecutive_failures", pg_type: "int4", nullable: false },
        ],
    };
}

/// Model `WebhookDelivery`, bảng `webhook_deliveries`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct WebhookDelivery {
    pub id: uuid::Uuid,
    pub endpoint_id: i32,
    pub event_id: Option<JsBigInt>,
    pub event_type: String,
    pub payload: JsonValue,
    pub status: String,
    pub attempts: i32,
    pub next_attempt_at: Timestamp,
    pub last_status_code: Option<i32>,
    pub last_error: Option<String>,
    pub created_at: Timestamp,
    pub delivered_at: Option<Timestamp>,
}

impl Model for WebhookDelivery {
    const INFO: ModelInfo = ModelInfo {
        name: "WebhookDelivery",
        table: "webhook_deliveries",
        columns: &[
            Column { name: "id", pg_type: "uuid", nullable: false },
            Column { name: "endpoint_id", pg_type: "int4", nullable: false },
            Column { name: "event_id", pg_type: "int8", nullable: true },
            Column { name: "event_type", pg_type: "varchar", nullable: false },
            Column { name: "payload", pg_type: "jsonb", nullable: false },
            Column { name: "status", pg_type: "varchar", nullable: false },
            Column { name: "attempts", pg_type: "int4", nullable: false },
            Column { name: "next_attempt_at", pg_type: "timestamptz", nullable: false },
            Column { name: "last_status_code", pg_type: "int4", nullable: true },
            Column { name: "last_error", pg_type: "varchar", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "delivered_at", pg_type: "timestamptz", nullable: true },
        ],
    };
}

/// Model `WebhookInboundSource`, bảng `webhook_inbound_sources`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct WebhookInboundSource {
    pub id: i32,
    pub name: String,
    pub token_hash: String,
    pub token_prefix: String,
    pub signing_secret_enc: Option<String>,
    pub default_assignee_id: i32,
    pub contact_source_id: i32,
    pub project_id: Option<i32>,
    pub is_active: bool,
    pub created_by: i32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub last_received_at: Option<Timestamp>,
}

impl Model for WebhookInboundSource {
    const INFO: ModelInfo = ModelInfo {
        name: "WebhookInboundSource",
        table: "webhook_inbound_sources",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "name", pg_type: "varchar", nullable: false },
            Column { name: "token_hash", pg_type: "varchar", nullable: false },
            Column { name: "token_prefix", pg_type: "varchar", nullable: false },
            Column { name: "signing_secret_enc", pg_type: "text", nullable: true },
            Column { name: "default_assignee_id", pg_type: "int4", nullable: false },
            Column { name: "contact_source_id", pg_type: "int4", nullable: false },
            Column { name: "project_id", pg_type: "int4", nullable: true },
            Column { name: "is_active", pg_type: "bool", nullable: false },
            Column { name: "created_by", pg_type: "int4", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
            Column { name: "last_received_at", pg_type: "timestamptz", nullable: true },
        ],
    };
}

/// Model `WebhookInboundReceipt`, bảng `webhook_inbound_receipts`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct WebhookInboundReceipt {
    pub id: JsBigInt,
    pub source_id: i32,
    pub external_id: String,
    pub contact_id: Option<i32>,
    pub created_at: Timestamp,
}

impl Model for WebhookInboundReceipt {
    const INFO: ModelInfo = ModelInfo {
        name: "WebhookInboundReceipt",
        table: "webhook_inbound_receipts",
        columns: &[
            Column { name: "id", pg_type: "int8", nullable: false },
            Column { name: "source_id", pg_type: "int4", nullable: false },
            Column { name: "external_id", pg_type: "varchar", nullable: false },
            Column { name: "contact_id", pg_type: "int4", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `OauthClient`, bảng `oauth_clients`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct OauthClient {
    pub id: i32,
    pub client_id: String,
    pub kind: String,
    pub name: String,
    pub redirect_uris: PgList<String>,
    pub logo_uri: Option<String>,
    pub client_uri: Option<String>,
    pub token_endpoint_auth_method: String,
    pub client_secret_hash: Option<String>,
    pub metadata: JsonValue,
    pub metadata_fetched_at: Option<Timestamp>,
    pub metadata_expires_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub last_used_at: Option<Timestamp>,
}

impl Model for OauthClient {
    const INFO: ModelInfo = ModelInfo {
        name: "OauthClient",
        table: "oauth_clients",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "client_id", pg_type: "varchar", nullable: false },
            Column { name: "kind", pg_type: "varchar", nullable: false },
            Column { name: "name", pg_type: "varchar", nullable: false },
            Column { name: "redirect_uris", pg_type: "_text", nullable: true },
            Column { name: "logo_uri", pg_type: "varchar", nullable: true },
            Column { name: "client_uri", pg_type: "varchar", nullable: true },
            Column { name: "token_endpoint_auth_method", pg_type: "varchar", nullable: false },
            Column { name: "client_secret_hash", pg_type: "varchar", nullable: true },
            Column { name: "metadata", pg_type: "jsonb", nullable: false },
            Column { name: "metadata_fetched_at", pg_type: "timestamptz", nullable: true },
            Column { name: "metadata_expires_at", pg_type: "timestamptz", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "last_used_at", pg_type: "timestamptz", nullable: true },
        ],
    };
}

/// Model `OauthAuthorizationCode`, bảng `oauth_authorization_codes`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct OauthAuthorizationCode {
    pub id: JsBigInt,
    pub code_hash: String,
    pub client_id: String,
    pub user_id: i32,
    pub redirect_uri: String,
    pub code_challenge: String,
    pub scopes: PgList<String>,
    pub resource: String,
    pub family_id: String,
    pub expires_at: Timestamp,
    pub used_at: Option<Timestamp>,
    pub created_at: Timestamp,
}

impl Model for OauthAuthorizationCode {
    const INFO: ModelInfo = ModelInfo {
        name: "OauthAuthorizationCode",
        table: "oauth_authorization_codes",
        columns: &[
            Column { name: "id", pg_type: "int8", nullable: false },
            Column { name: "code_hash", pg_type: "varchar", nullable: false },
            Column { name: "client_id", pg_type: "varchar", nullable: false },
            Column { name: "user_id", pg_type: "int4", nullable: false },
            Column { name: "redirect_uri", pg_type: "varchar", nullable: false },
            Column { name: "code_challenge", pg_type: "varchar", nullable: false },
            Column { name: "scopes", pg_type: "_text", nullable: true },
            Column { name: "resource", pg_type: "varchar", nullable: false },
            Column { name: "family_id", pg_type: "varchar", nullable: false },
            Column { name: "expires_at", pg_type: "timestamptz", nullable: false },
            Column { name: "used_at", pg_type: "timestamptz", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `OauthToken`, bảng `oauth_tokens`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct OauthToken {
    pub id: JsBigInt,
    pub access_hash: String,
    pub refresh_hash: String,
    pub client_id: String,
    pub user_id: i32,
    pub scopes: PgList<String>,
    pub resource: String,
    pub family_id: String,
    pub access_expires_at: Timestamp,
    pub refresh_expires_at: Timestamp,
    pub refresh_used_at: Option<Timestamp>,
    pub revoked_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub last_used_at: Option<Timestamp>,
}

impl Model for OauthToken {
    const INFO: ModelInfo = ModelInfo {
        name: "OauthToken",
        table: "oauth_tokens",
        columns: &[
            Column { name: "id", pg_type: "int8", nullable: false },
            Column { name: "access_hash", pg_type: "varchar", nullable: false },
            Column { name: "refresh_hash", pg_type: "varchar", nullable: false },
            Column { name: "client_id", pg_type: "varchar", nullable: false },
            Column { name: "user_id", pg_type: "int4", nullable: false },
            Column { name: "scopes", pg_type: "_text", nullable: true },
            Column { name: "resource", pg_type: "varchar", nullable: false },
            Column { name: "family_id", pg_type: "varchar", nullable: false },
            Column { name: "access_expires_at", pg_type: "timestamptz", nullable: false },
            Column { name: "refresh_expires_at", pg_type: "timestamptz", nullable: false },
            Column { name: "refresh_used_at", pg_type: "timestamptz", nullable: true },
            Column { name: "revoked_at", pg_type: "timestamptz", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "last_used_at", pg_type: "timestamptz", nullable: true },
        ],
    };
}

/// Model `AiActionDraft`, bảng `ai_action_drafts`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct AiActionDraft {
    pub id: i32,
    pub user_id: i32,
    pub client_id: String,
    pub tool: String,
    pub params: JsonValue,
    pub summary: String,
    pub details: JsonValue,
    pub status: String,
    pub result: Option<JsonValue>,
    pub error: Option<String>,
    pub impact: Option<JsonValue>,
    pub created_at: Timestamp,
    pub decided_at: Option<Timestamp>,
    pub expires_at: Timestamp,
}

impl Model for AiActionDraft {
    const INFO: ModelInfo = ModelInfo {
        name: "AiActionDraft",
        table: "ai_action_drafts",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "user_id", pg_type: "int4", nullable: false },
            Column { name: "client_id", pg_type: "varchar", nullable: false },
            Column { name: "tool", pg_type: "varchar", nullable: false },
            Column { name: "params", pg_type: "jsonb", nullable: false },
            Column { name: "summary", pg_type: "varchar", nullable: false },
            Column { name: "details", pg_type: "jsonb", nullable: false },
            Column { name: "status", pg_type: "varchar", nullable: false },
            Column { name: "result", pg_type: "jsonb", nullable: true },
            Column { name: "error", pg_type: "varchar", nullable: true },
            Column { name: "impact", pg_type: "jsonb", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "decided_at", pg_type: "timestamptz", nullable: true },
            Column { name: "expires_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `CustomObject`, bảng `custom_objects`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct CustomObject {
    pub id: i32,
    pub key: String,
    pub label: String,
    pub label_plural: String,
    pub icon: Option<String>,
    pub description: Option<String>,
    pub show_in_nav: bool,
    pub nav_order: i32,
    pub visible_role_ids: PgList<i32>,
    pub is_active: bool,
    pub code_prefix: Option<String>,
    pub code_prefix_aliases: PgList<String>,
    pub next_code_seq: Option<i32>,
    pub created_by: Option<i32>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub deleted_at: Option<Timestamp>,
}

impl Model for CustomObject {
    const INFO: ModelInfo = ModelInfo {
        name: "CustomObject",
        table: "custom_objects",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "key", pg_type: "varchar", nullable: false },
            Column { name: "label", pg_type: "varchar", nullable: false },
            Column { name: "label_plural", pg_type: "varchar", nullable: false },
            Column { name: "icon", pg_type: "varchar", nullable: true },
            Column { name: "description", pg_type: "varchar", nullable: true },
            Column { name: "show_in_nav", pg_type: "bool", nullable: false },
            Column { name: "nav_order", pg_type: "int4", nullable: false },
            Column { name: "visible_role_ids", pg_type: "_int4", nullable: true },
            Column { name: "is_active", pg_type: "bool", nullable: false },
            Column { name: "code_prefix", pg_type: "varchar", nullable: true },
            Column { name: "code_prefix_aliases", pg_type: "_varchar", nullable: true },
            Column { name: "next_code_seq", pg_type: "int4", nullable: true },
            Column { name: "created_by", pg_type: "int4", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
            Column { name: "deleted_at", pg_type: "timestamptz", nullable: true },
        ],
    };
}

/// Model `CustomField`, bảng `custom_fields`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct CustomField {
    pub id: i32,
    pub object_id: i32,
    pub key: String,
    pub label: String,
    #[sqlx(rename = "type")]
    pub r#type: String,
    pub required: bool,
    pub is_unique: bool,
    pub is_title: bool,
    pub show_in_list: bool,
    pub sort_order: i32,
    pub options: JsonValue,
    pub help_text: Option<String>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub deleted_at: Option<Timestamp>,
}

impl Model for CustomField {
    const INFO: ModelInfo = ModelInfo {
        name: "CustomField",
        table: "custom_fields",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "object_id", pg_type: "int4", nullable: false },
            Column { name: "key", pg_type: "varchar", nullable: false },
            Column { name: "label", pg_type: "varchar", nullable: false },
            Column { name: "type", pg_type: "varchar", nullable: false },
            Column { name: "required", pg_type: "bool", nullable: false },
            Column { name: "is_unique", pg_type: "bool", nullable: false },
            Column { name: "is_title", pg_type: "bool", nullable: false },
            Column { name: "show_in_list", pg_type: "bool", nullable: false },
            Column { name: "sort_order", pg_type: "int4", nullable: false },
            Column { name: "options", pg_type: "jsonb", nullable: false },
            Column { name: "help_text", pg_type: "varchar", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
            Column { name: "deleted_at", pg_type: "timestamptz", nullable: true },
        ],
    };
}

/// Model `CustomRecord`, bảng `custom_records`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct CustomRecord {
    pub id: i32,
    pub object_id: i32,
    pub data: JsonValue,
    pub title: Option<String>,
    pub code: Option<String>,
    pub code_seq: Option<i32>,
    pub owner_id: Option<i32>,
    pub created_by: Option<i32>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub deleted_at: Option<Timestamp>,
}

impl Model for CustomRecord {
    const INFO: ModelInfo = ModelInfo {
        name: "CustomRecord",
        table: "custom_records",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "object_id", pg_type: "int4", nullable: false },
            Column { name: "data", pg_type: "jsonb", nullable: false },
            Column { name: "title", pg_type: "varchar", nullable: true },
            Column { name: "code", pg_type: "varchar", nullable: true },
            Column { name: "code_seq", pg_type: "int4", nullable: true },
            Column { name: "owner_id", pg_type: "int4", nullable: true },
            Column { name: "created_by", pg_type: "int4", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
            Column { name: "deleted_at", pg_type: "timestamptz", nullable: true },
        ],
    };
}

/// Model `CustomView`, bảng `custom_views`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct CustomView {
    pub id: i32,
    pub object_id: i32,
    pub key: String,
    pub label: String,
    #[sqlx(rename = "type")]
    pub r#type: String,
    pub config: JsonValue,
    pub icon: Option<String>,
    pub show_in_nav: bool,
    pub nav_order: i32,
    pub visible_role_ids: PgList<i32>,
    pub created_by: Option<i32>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
    pub deleted_at: Option<Timestamp>,
}

impl Model for CustomView {
    const INFO: ModelInfo = ModelInfo {
        name: "CustomView",
        table: "custom_views",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "object_id", pg_type: "int4", nullable: false },
            Column { name: "key", pg_type: "varchar", nullable: false },
            Column { name: "label", pg_type: "varchar", nullable: false },
            Column { name: "type", pg_type: "varchar", nullable: false },
            Column { name: "config", pg_type: "jsonb", nullable: false },
            Column { name: "icon", pg_type: "varchar", nullable: true },
            Column { name: "show_in_nav", pg_type: "bool", nullable: false },
            Column { name: "nav_order", pg_type: "int4", nullable: false },
            Column { name: "visible_role_ids", pg_type: "_int4", nullable: true },
            Column { name: "created_by", pg_type: "int4", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
            Column { name: "deleted_at", pg_type: "timestamptz", nullable: true },
        ],
    };
}

/// Model `RecordLink`, bảng `record_links`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct RecordLink {
    pub id: i32,
    pub source_type: String,
    pub source_id: i32,
    pub source_field: String,
    pub target_type: String,
    pub target_id: i32,
    pub created_by: Option<i32>,
    pub created_at: Timestamp,
}

impl Model for RecordLink {
    const INFO: ModelInfo = ModelInfo {
        name: "RecordLink",
        table: "record_links",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "source_type", pg_type: "varchar", nullable: false },
            Column { name: "source_id", pg_type: "int4", nullable: false },
            Column { name: "source_field", pg_type: "varchar", nullable: false },
            Column { name: "target_type", pg_type: "varchar", nullable: false },
            Column { name: "target_id", pg_type: "int4", nullable: false },
            Column { name: "created_by", pg_type: "int4", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `CustomSchemaVersion`, bảng `custom_schema_versions`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct CustomSchemaVersion {
    pub id: i32,
    pub draft_id: Option<i32>,
    pub tool: String,
    pub summary: String,
    pub snapshot: JsonValue,
    pub created_by: Option<i32>,
    pub created_at: Timestamp,
}

impl Model for CustomSchemaVersion {
    const INFO: ModelInfo = ModelInfo {
        name: "CustomSchemaVersion",
        table: "custom_schema_versions",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "draft_id", pg_type: "int4", nullable: true },
            Column { name: "tool", pg_type: "varchar", nullable: false },
            Column { name: "summary", pg_type: "varchar", nullable: false },
            Column { name: "snapshot", pg_type: "jsonb", nullable: false },
            Column { name: "created_by", pg_type: "int4", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `ZaloOaConnection`, bảng `zalo_oa_connections`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct ZaloOaConnection {
    pub id: i32,
    pub oa_id: String,
    pub access_token_enc: String,
    pub refresh_token_enc: String,
    pub access_expires_at: Timestamp,
    pub refresh_expires_at: Option<Timestamp>,
    pub status: String,
    pub last_error: Option<String>,
    pub last_refreshed_at: Option<Timestamp>,
    pub connected_by: i32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for ZaloOaConnection {
    const INFO: ModelInfo = ModelInfo {
        name: "ZaloOaConnection",
        table: "zalo_oa_connections",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "oa_id", pg_type: "varchar", nullable: false },
            Column { name: "access_token_enc", pg_type: "text", nullable: false },
            Column { name: "refresh_token_enc", pg_type: "text", nullable: false },
            Column { name: "access_expires_at", pg_type: "timestamptz", nullable: false },
            Column { name: "refresh_expires_at", pg_type: "timestamptz", nullable: true },
            Column { name: "status", pg_type: "varchar", nullable: false },
            Column { name: "last_error", pg_type: "varchar", nullable: true },
            Column { name: "last_refreshed_at", pg_type: "timestamptz", nullable: true },
            Column { name: "connected_by", pg_type: "int4", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `ZaloOaOauthState`, bảng `zalo_oa_oauth_states`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct ZaloOaOauthState {
    pub state: String,
    pub code_verifier_enc: String,
    pub user_id: i32,
    pub expires_at: Timestamp,
    pub created_at: Timestamp,
}

impl Model for ZaloOaOauthState {
    const INFO: ModelInfo = ModelInfo {
        name: "ZaloOaOauthState",
        table: "zalo_oa_oauth_states",
        columns: &[
            Column { name: "state", pg_type: "varchar", nullable: false },
            Column { name: "code_verifier_enc", pg_type: "text", nullable: false },
            Column { name: "user_id", pg_type: "int4", nullable: false },
            Column { name: "expires_at", pg_type: "timestamptz", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `ZaloOaThread`, bảng `zalo_oa_threads`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct ZaloOaThread {
    pub id: i32,
    pub oa_id: String,
    pub zalo_user_id: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub phone: Option<String>,
    pub contact_id: Option<i32>,
    pub last_message_preview: Option<String>,
    pub last_message_at: Option<Timestamp>,
    pub last_inbound_at: Option<Timestamp>,
    pub unread_count: i32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for ZaloOaThread {
    const INFO: ModelInfo = ModelInfo {
        name: "ZaloOaThread",
        table: "zalo_oa_threads",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "oa_id", pg_type: "varchar", nullable: false },
            Column { name: "zalo_user_id", pg_type: "varchar", nullable: false },
            Column { name: "display_name", pg_type: "varchar", nullable: true },
            Column { name: "avatar_url", pg_type: "varchar", nullable: true },
            Column { name: "phone", pg_type: "varchar", nullable: true },
            Column { name: "contact_id", pg_type: "int4", nullable: true },
            Column { name: "last_message_preview", pg_type: "varchar", nullable: true },
            Column { name: "last_message_at", pg_type: "timestamptz", nullable: true },
            Column { name: "last_inbound_at", pg_type: "timestamptz", nullable: true },
            Column { name: "unread_count", pg_type: "int4", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `ZaloOaMessage`, bảng `zalo_oa_messages`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct ZaloOaMessage {
    pub id: JsBigInt,
    pub thread_id: i32,
    pub direction: String,
    pub kind: String,
    pub msg_id: Option<String>,
    pub text: Option<String>,
    pub payload: JsonValue,
    pub status: String,
    pub error: Option<String>,
    pub sent_by: Option<i32>,
    pub created_at: Timestamp,
}

impl Model for ZaloOaMessage {
    const INFO: ModelInfo = ModelInfo {
        name: "ZaloOaMessage",
        table: "zalo_oa_messages",
        columns: &[
            Column { name: "id", pg_type: "int8", nullable: false },
            Column { name: "thread_id", pg_type: "int4", nullable: false },
            Column { name: "direction", pg_type: "varchar", nullable: false },
            Column { name: "kind", pg_type: "varchar", nullable: false },
            Column { name: "msg_id", pg_type: "varchar", nullable: true },
            Column { name: "text", pg_type: "text", nullable: true },
            Column { name: "payload", pg_type: "jsonb", nullable: false },
            Column { name: "status", pg_type: "varchar", nullable: false },
            Column { name: "error", pg_type: "varchar", nullable: true },
            Column { name: "sent_by", pg_type: "int4", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `Briefing`, bảng `briefings`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct Briefing {
    pub id: i32,
    pub user_id: i32,
    pub slot: String,
    pub day: String,
    pub title: String,
    pub text: String,
    pub data: JsonValue,
    pub channels: JsonValue,
    pub created_at: Timestamp,
}

impl Model for Briefing {
    const INFO: ModelInfo = ModelInfo {
        name: "Briefing",
        table: "briefings",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "user_id", pg_type: "int4", nullable: false },
            Column { name: "slot", pg_type: "varchar", nullable: false },
            Column { name: "day", pg_type: "varchar", nullable: false },
            Column { name: "title", pg_type: "varchar", nullable: false },
            Column { name: "text", pg_type: "text", nullable: false },
            Column { name: "data", pg_type: "jsonb", nullable: false },
            Column { name: "channels", pg_type: "jsonb", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `FacebookPage`, bảng `facebook_pages`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct FacebookPage {
    pub id: i32,
    pub page_id: String,
    pub name: String,
    pub token_enc: String,
    pub token_status: String,
    pub token_checked_at: Option<Timestamp>,
    pub token_expires_at: Option<Timestamp>,
    pub data_access_expires_at: Option<Timestamp>,
    pub subscribed: bool,
    pub default_assignee_id: i32,
    pub contact_source_id: i32,
    pub project_id: Option<i32>,
    pub is_active: bool,
    pub connected_by: i32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for FacebookPage {
    const INFO: ModelInfo = ModelInfo {
        name: "FacebookPage",
        table: "facebook_pages",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "page_id", pg_type: "varchar", nullable: false },
            Column { name: "name", pg_type: "varchar", nullable: false },
            Column { name: "token_enc", pg_type: "text", nullable: false },
            Column { name: "token_status", pg_type: "varchar", nullable: false },
            Column { name: "token_checked_at", pg_type: "timestamptz", nullable: true },
            Column { name: "token_expires_at", pg_type: "timestamptz", nullable: true },
            Column { name: "data_access_expires_at", pg_type: "timestamptz", nullable: true },
            Column { name: "subscribed", pg_type: "bool", nullable: false },
            Column { name: "default_assignee_id", pg_type: "int4", nullable: false },
            Column { name: "contact_source_id", pg_type: "int4", nullable: false },
            Column { name: "project_id", pg_type: "int4", nullable: true },
            Column { name: "is_active", pg_type: "bool", nullable: false },
            Column { name: "connected_by", pg_type: "int4", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `FacebookConversation`, bảng `facebook_conversations`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct FacebookConversation {
    pub id: i32,
    pub page_id: String,
    pub psid: String,
    pub customer_name: Option<String>,
    pub contact_id: Option<i32>,
    pub last_inbound_at: Option<Timestamp>,
    pub last_message_at: Timestamp,
    pub last_message_preview: Option<String>,
    pub unread_count: i32,
    pub entry_link_id: Option<i32>,
    pub created_at: Timestamp,
}

impl Model for FacebookConversation {
    const INFO: ModelInfo = ModelInfo {
        name: "FacebookConversation",
        table: "facebook_conversations",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "page_id", pg_type: "varchar", nullable: false },
            Column { name: "psid", pg_type: "varchar", nullable: false },
            Column { name: "customer_name", pg_type: "varchar", nullable: true },
            Column { name: "contact_id", pg_type: "int4", nullable: true },
            Column { name: "last_inbound_at", pg_type: "timestamptz", nullable: true },
            Column { name: "last_message_at", pg_type: "timestamptz", nullable: false },
            Column { name: "last_message_preview", pg_type: "varchar", nullable: true },
            Column { name: "unread_count", pg_type: "int4", nullable: false },
            Column { name: "entry_link_id", pg_type: "int4", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `FacebookBroadcast`, bảng `facebook_broadcasts`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct FacebookBroadcast {
    pub id: i32,
    pub name: String,
    pub page_id: String,
    pub text: String,
    pub audience: JsonValue,
    pub status: String,
    pub scheduled_at: Option<Timestamp>,
    pub total: i32,
    pub sent: i32,
    pub failed: i32,
    pub skipped: i32,
    pub source: String,
    pub created_by: i32,
    pub started_at: Option<Timestamp>,
    pub finished_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for FacebookBroadcast {
    const INFO: ModelInfo = ModelInfo {
        name: "FacebookBroadcast",
        table: "facebook_broadcasts",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "name", pg_type: "varchar", nullable: false },
            Column { name: "page_id", pg_type: "varchar", nullable: false },
            Column { name: "text", pg_type: "text", nullable: false },
            Column { name: "audience", pg_type: "jsonb", nullable: false },
            Column { name: "status", pg_type: "varchar", nullable: false },
            Column { name: "scheduled_at", pg_type: "timestamptz", nullable: true },
            Column { name: "total", pg_type: "int4", nullable: false },
            Column { name: "sent", pg_type: "int4", nullable: false },
            Column { name: "failed", pg_type: "int4", nullable: false },
            Column { name: "skipped", pg_type: "int4", nullable: false },
            Column { name: "source", pg_type: "varchar", nullable: false },
            Column { name: "created_by", pg_type: "int4", nullable: false },
            Column { name: "started_at", pg_type: "timestamptz", nullable: true },
            Column { name: "finished_at", pg_type: "timestamptz", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `FacebookBroadcastRecipient`, bảng `facebook_broadcast_recipients`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct FacebookBroadcastRecipient {
    pub id: i32,
    pub broadcast_id: i32,
    pub conversation_id: i32,
    pub status: String,
    pub note: Option<String>,
    pub claimed_at: Option<Timestamp>,
    pub sent_at: Option<Timestamp>,
}

impl Model for FacebookBroadcastRecipient {
    const INFO: ModelInfo = ModelInfo {
        name: "FacebookBroadcastRecipient",
        table: "facebook_broadcast_recipients",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "broadcast_id", pg_type: "int4", nullable: false },
            Column { name: "conversation_id", pg_type: "int4", nullable: false },
            Column { name: "status", pg_type: "varchar", nullable: false },
            Column { name: "note", pg_type: "varchar", nullable: true },
            Column { name: "claimed_at", pg_type: "timestamptz", nullable: true },
            Column { name: "sent_at", pg_type: "timestamptz", nullable: true },
        ],
    };
}

/// Model `FacebookMessage`, bảng `facebook_messages`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct FacebookMessage {
    pub id: JsBigInt,
    pub conversation_id: i32,
    pub mid: String,
    pub direction: String,
    pub text: Option<String>,
    pub sent_by_user_id: Option<i32>,
    pub sent_at: Timestamp,
}

impl Model for FacebookMessage {
    const INFO: ModelInfo = ModelInfo {
        name: "FacebookMessage",
        table: "facebook_messages",
        columns: &[
            Column { name: "id", pg_type: "int8", nullable: false },
            Column { name: "conversation_id", pg_type: "int4", nullable: false },
            Column { name: "mid", pg_type: "varchar", nullable: false },
            Column { name: "direction", pg_type: "varchar", nullable: false },
            Column { name: "text", pg_type: "text", nullable: true },
            Column { name: "sent_by_user_id", pg_type: "int4", nullable: true },
            Column { name: "sent_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `FacebookComment`, bảng `facebook_comments`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct FacebookComment {
    pub id: JsBigInt,
    pub comment_id: String,
    pub page_id: String,
    pub post_id: String,
    pub parent_id: Option<String>,
    pub from_id: Option<String>,
    pub from_name: Option<String>,
    pub message: Option<String>,
    pub commented_at: Timestamp,
    pub contact_id: Option<i32>,
    pub phone: Option<String>,
    pub rule_id: Option<i32>,
    pub status: String,
    pub note: Option<String>,
    pub actions: JsonValue,
    pub hidden: bool,
    pub created_at: Timestamp,
}

impl Model for FacebookComment {
    const INFO: ModelInfo = ModelInfo {
        name: "FacebookComment",
        table: "facebook_comments",
        columns: &[
            Column { name: "id", pg_type: "int8", nullable: false },
            Column { name: "comment_id", pg_type: "varchar", nullable: false },
            Column { name: "page_id", pg_type: "varchar", nullable: false },
            Column { name: "post_id", pg_type: "varchar", nullable: false },
            Column { name: "parent_id", pg_type: "varchar", nullable: true },
            Column { name: "from_id", pg_type: "varchar", nullable: true },
            Column { name: "from_name", pg_type: "varchar", nullable: true },
            Column { name: "message", pg_type: "text", nullable: true },
            Column { name: "commented_at", pg_type: "timestamptz", nullable: false },
            Column { name: "contact_id", pg_type: "int4", nullable: true },
            Column { name: "phone", pg_type: "varchar", nullable: true },
            Column { name: "rule_id", pg_type: "int4", nullable: true },
            Column { name: "status", pg_type: "varchar", nullable: false },
            Column { name: "note", pg_type: "varchar", nullable: true },
            Column { name: "actions", pg_type: "jsonb", nullable: false },
            Column { name: "hidden", pg_type: "bool", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `FacebookCommentRule`, bảng `facebook_comment_rules`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct FacebookCommentRule {
    pub id: i32,
    pub name: String,
    pub page_id: Option<String>,
    pub post_id: Option<String>,
    pub keywords: PgList<String>,
    pub exclude_keywords: PgList<String>,
    pub public_replies: PgList<String>,
    pub private_reply: Option<String>,
    pub hide_if_phone: bool,
    pub once_per_user: bool,
    pub mode: String,
    pub is_active: bool,
    pub position: i32,
    pub created_by: i32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for FacebookCommentRule {
    const INFO: ModelInfo = ModelInfo {
        name: "FacebookCommentRule",
        table: "facebook_comment_rules",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "name", pg_type: "varchar", nullable: false },
            Column { name: "page_id", pg_type: "varchar", nullable: true },
            Column { name: "post_id", pg_type: "varchar", nullable: true },
            Column { name: "keywords", pg_type: "_text", nullable: true },
            Column { name: "exclude_keywords", pg_type: "_text", nullable: true },
            Column { name: "public_replies", pg_type: "_text", nullable: true },
            Column { name: "private_reply", pg_type: "text", nullable: true },
            Column { name: "hide_if_phone", pg_type: "bool", nullable: false },
            Column { name: "once_per_user", pg_type: "bool", nullable: false },
            Column { name: "mode", pg_type: "varchar", nullable: false },
            Column { name: "is_active", pg_type: "bool", nullable: false },
            Column { name: "position", pg_type: "int4", nullable: false },
            Column { name: "created_by", pg_type: "int4", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `FacebookLeadReceipt`, bảng `facebook_lead_receipts`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct FacebookLeadReceipt {
    pub id: JsBigInt,
    pub leadgen_id: String,
    pub page_id: String,
    pub form_id: Option<String>,
    pub contact_id: Option<i32>,
    pub result: String,
    pub created_at: Timestamp,
}

impl Model for FacebookLeadReceipt {
    const INFO: ModelInfo = ModelInfo {
        name: "FacebookLeadReceipt",
        table: "facebook_lead_receipts",
        columns: &[
            Column { name: "id", pg_type: "int8", nullable: false },
            Column { name: "leadgen_id", pg_type: "varchar", nullable: false },
            Column { name: "page_id", pg_type: "varchar", nullable: false },
            Column { name: "form_id", pg_type: "varchar", nullable: true },
            Column { name: "contact_id", pg_type: "int4", nullable: true },
            Column { name: "result", pg_type: "varchar", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `SocialAccount`, bảng `social_accounts`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct SocialAccount {
    pub id: i32,
    pub network: String,
    pub external_id: String,
    pub name: String,
    pub avatar_url: Option<String>,
    pub access_token_enc: String,
    pub refresh_token_enc: Option<String>,
    pub token_expires_at: Option<Timestamp>,
    pub scopes: String,
    pub status: String,
    pub last_error: Option<String>,
    pub connected_by: i32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for SocialAccount {
    const INFO: ModelInfo = ModelInfo {
        name: "SocialAccount",
        table: "social_accounts",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "network", pg_type: "varchar", nullable: false },
            Column { name: "external_id", pg_type: "varchar", nullable: false },
            Column { name: "name", pg_type: "varchar", nullable: false },
            Column { name: "avatar_url", pg_type: "text", nullable: true },
            Column { name: "access_token_enc", pg_type: "text", nullable: false },
            Column { name: "refresh_token_enc", pg_type: "text", nullable: true },
            Column { name: "token_expires_at", pg_type: "timestamptz", nullable: true },
            Column { name: "scopes", pg_type: "text", nullable: false },
            Column { name: "status", pg_type: "varchar", nullable: false },
            Column { name: "last_error", pg_type: "varchar", nullable: true },
            Column { name: "connected_by", pg_type: "int4", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `SocialPost`, bảng `social_posts`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct SocialPost {
    pub id: i32,
    pub content: String,
    pub media: JsonValue,
    pub scheduled_at: Option<Timestamp>,
    pub status: String,
    pub source: String,
    pub created_by: i32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for SocialPost {
    const INFO: ModelInfo = ModelInfo {
        name: "SocialPost",
        table: "social_posts",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "content", pg_type: "text", nullable: false },
            Column { name: "media", pg_type: "jsonb", nullable: false },
            Column { name: "scheduled_at", pg_type: "timestamptz", nullable: true },
            Column { name: "status", pg_type: "varchar", nullable: false },
            Column { name: "source", pg_type: "varchar", nullable: false },
            Column { name: "created_by", pg_type: "int4", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `SocialDraft`, bảng `social_drafts`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct SocialDraft {
    pub id: i32,
    pub title: Option<String>,
    pub content: String,
    pub media: JsonValue,
    pub targets: JsonValue,
    pub scheduled_at: Option<Timestamp>,
    pub use_queue: bool,
    pub ui: Option<JsonValue>,
    pub post_id: Option<i32>,
    pub publishing_at: Option<Timestamp>,
    pub source: String,
    pub created_by: i32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for SocialDraft {
    const INFO: ModelInfo = ModelInfo {
        name: "SocialDraft",
        table: "social_drafts",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "title", pg_type: "varchar", nullable: true },
            Column { name: "content", pg_type: "text", nullable: false },
            Column { name: "media", pg_type: "jsonb", nullable: false },
            Column { name: "targets", pg_type: "jsonb", nullable: false },
            Column { name: "scheduled_at", pg_type: "timestamptz", nullable: true },
            Column { name: "use_queue", pg_type: "bool", nullable: false },
            Column { name: "ui", pg_type: "jsonb", nullable: true },
            Column { name: "post_id", pg_type: "int4", nullable: true },
            Column { name: "publishing_at", pg_type: "timestamptz", nullable: true },
            Column { name: "source", pg_type: "varchar", nullable: false },
            Column { name: "created_by", pg_type: "int4", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `SocialRecurrence`, bảng `social_recurrences`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct SocialRecurrence {
    pub id: i32,
    pub title: String,
    pub template: JsonValue,
    pub rule: JsonValue,
    pub starts_on: DbDate,
    pub ends_on: Option<DbDate>,
    pub max_count: Option<i32>,
    pub count: i32,
    pub next_run_at: Option<Timestamp>,
    pub active: bool,
    pub last_error: Option<String>,
    pub created_by: i32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for SocialRecurrence {
    const INFO: ModelInfo = ModelInfo {
        name: "SocialRecurrence",
        table: "social_recurrences",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "title", pg_type: "varchar", nullable: false },
            Column { name: "template", pg_type: "jsonb", nullable: false },
            Column { name: "rule", pg_type: "jsonb", nullable: false },
            Column { name: "starts_on", pg_type: "date", nullable: false },
            Column { name: "ends_on", pg_type: "date", nullable: true },
            Column { name: "max_count", pg_type: "int4", nullable: true },
            Column { name: "count", pg_type: "int4", nullable: false },
            Column { name: "next_run_at", pg_type: "timestamptz", nullable: true },
            Column { name: "active", pg_type: "bool", nullable: false },
            Column { name: "last_error", pg_type: "text", nullable: true },
            Column { name: "created_by", pg_type: "int4", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `SocialQueueSlot`, bảng `social_queue_slots`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct SocialQueueSlot {
    pub id: i32,
    pub weekday: i32,
    pub minute: i32,
    pub created_at: Timestamp,
}

impl Model for SocialQueueSlot {
    const INFO: ModelInfo = ModelInfo {
        name: "SocialQueueSlot",
        table: "social_queue_slots",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "weekday", pg_type: "int4", nullable: false },
            Column { name: "minute", pg_type: "int4", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `SocialSnippet`, bảng `social_snippets`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct SocialSnippet {
    pub id: i32,
    pub kind: String,
    pub name: String,
    pub content: String,
    pub is_default: bool,
    pub position: i32,
    pub created_by: i32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for SocialSnippet {
    const INFO: ModelInfo = ModelInfo {
        name: "SocialSnippet",
        table: "social_snippets",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "kind", pg_type: "varchar", nullable: false },
            Column { name: "name", pg_type: "varchar", nullable: false },
            Column { name: "content", pg_type: "text", nullable: false },
            Column { name: "is_default", pg_type: "bool", nullable: false },
            Column { name: "position", pg_type: "int4", nullable: false },
            Column { name: "created_by", pg_type: "int4", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `SocialMediaAsset`, bảng `social_media_assets`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct SocialMediaAsset {
    pub id: i32,
    pub key: String,
    #[sqlx(rename = "type")]
    pub r#type: String,
    pub content_type: String,
    pub size: i32,
    pub name: String,
    pub source: String,
    pub uploaded_by: i32,
    pub hidden_at: Option<Timestamp>,
    pub created_at: Timestamp,
}

impl Model for SocialMediaAsset {
    const INFO: ModelInfo = ModelInfo {
        name: "SocialMediaAsset",
        table: "social_media_assets",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "key", pg_type: "varchar", nullable: false },
            Column { name: "type", pg_type: "varchar", nullable: false },
            Column { name: "content_type", pg_type: "varchar", nullable: false },
            Column { name: "size", pg_type: "int4", nullable: false },
            Column { name: "name", pg_type: "varchar", nullable: false },
            Column { name: "source", pg_type: "varchar", nullable: false },
            Column { name: "uploaded_by", pg_type: "int4", nullable: false },
            Column { name: "hidden_at", pg_type: "timestamptz", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `SocialPostTarget`, bảng `social_post_targets`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct SocialPostTarget {
    pub id: i32,
    pub post_id: i32,
    pub account_id: i32,
    pub network: String,
    pub caption: Option<String>,
    pub options: JsonValue,
    pub status: String,
    pub attempts: i32,
    pub next_attempt_at: Timestamp,
    pub claimed_at: Option<Timestamp>,
    pub external_post_id: Option<String>,
    pub url: Option<String>,
    pub last_error: Option<String>,
    pub published_at: Option<Timestamp>,
    pub metrics: Option<JsonValue>,
    pub metrics_at: Option<Timestamp>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for SocialPostTarget {
    const INFO: ModelInfo = ModelInfo {
        name: "SocialPostTarget",
        table: "social_post_targets",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "post_id", pg_type: "int4", nullable: false },
            Column { name: "account_id", pg_type: "int4", nullable: false },
            Column { name: "network", pg_type: "varchar", nullable: false },
            Column { name: "caption", pg_type: "text", nullable: true },
            Column { name: "options", pg_type: "jsonb", nullable: false },
            Column { name: "status", pg_type: "varchar", nullable: false },
            Column { name: "attempts", pg_type: "int4", nullable: false },
            Column { name: "next_attempt_at", pg_type: "timestamptz", nullable: false },
            Column { name: "claimed_at", pg_type: "timestamptz", nullable: true },
            Column { name: "external_post_id", pg_type: "varchar", nullable: true },
            Column { name: "url", pg_type: "text", nullable: true },
            Column { name: "last_error", pg_type: "varchar", nullable: true },
            Column { name: "published_at", pg_type: "timestamptz", nullable: true },
            Column { name: "metrics", pg_type: "jsonb", nullable: true },
            Column { name: "metrics_at", pg_type: "timestamptz", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `FacebookChatLink`, bảng `facebook_chat_links`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct FacebookChatLink {
    pub id: i32,
    pub code: String,
    pub name: String,
    pub page_id: String,
    pub source_id: Option<i32>,
    pub is_active: bool,
    pub clicks: i32,
    pub chats: i32,
    pub created_by: i32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for FacebookChatLink {
    const INFO: ModelInfo = ModelInfo {
        name: "FacebookChatLink",
        table: "facebook_chat_links",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "code", pg_type: "varchar", nullable: false },
            Column { name: "name", pg_type: "varchar", nullable: false },
            Column { name: "page_id", pg_type: "varchar", nullable: false },
            Column { name: "source_id", pg_type: "int4", nullable: true },
            Column { name: "is_active", pg_type: "bool", nullable: false },
            Column { name: "clicks", pg_type: "int4", nullable: false },
            Column { name: "chats", pg_type: "int4", nullable: false },
            Column { name: "created_by", pg_type: "int4", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `FacebookFlow`, bảng `facebook_flows`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct FacebookFlow {
    pub id: i32,
    pub name: String,
    pub page_id: String,
    pub trigger: String,
    pub keywords: PgList<String>,
    pub chat_link_id: Option<i32>,
    pub steps: JsonValue,
    pub is_active: bool,
    pub starts: i32,
    pub completes: i32,
    pub created_by: i32,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for FacebookFlow {
    const INFO: ModelInfo = ModelInfo {
        name: "FacebookFlow",
        table: "facebook_flows",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "name", pg_type: "varchar", nullable: false },
            Column { name: "page_id", pg_type: "varchar", nullable: false },
            Column { name: "trigger", pg_type: "varchar", nullable: false },
            Column { name: "keywords", pg_type: "_text", nullable: true },
            Column { name: "chat_link_id", pg_type: "int4", nullable: true },
            Column { name: "steps", pg_type: "jsonb", nullable: false },
            Column { name: "is_active", pg_type: "bool", nullable: false },
            Column { name: "starts", pg_type: "int4", nullable: false },
            Column { name: "completes", pg_type: "int4", nullable: false },
            Column { name: "created_by", pg_type: "int4", nullable: false },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `FacebookFlowRun`, bảng `facebook_flow_runs`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct FacebookFlowRun {
    pub id: i32,
    pub flow_id: i32,
    pub conversation_id: i32,
    pub step_id: Option<String>,
    pub status: String,
    pub due_at: Option<Timestamp>,
    pub note: Option<String>,
    pub started_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for FacebookFlowRun {
    const INFO: ModelInfo = ModelInfo {
        name: "FacebookFlowRun",
        table: "facebook_flow_runs",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "flow_id", pg_type: "int4", nullable: false },
            Column { name: "conversation_id", pg_type: "int4", nullable: false },
            Column { name: "step_id", pg_type: "varchar", nullable: true },
            Column { name: "status", pg_type: "varchar", nullable: false },
            Column { name: "due_at", pg_type: "timestamptz", nullable: true },
            Column { name: "note", pg_type: "varchar", nullable: true },
            Column { name: "started_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `StoreOrder`, bảng `store_orders`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct StoreOrder {
    pub id: i32,
    pub code: String,
    pub status: String,
    pub customer_name: String,
    pub customer_phone: String,
    pub customer_address: Option<String>,
    pub note: Option<String>,
    pub items: JsonValue,
    pub total: JsBigInt,
    pub payment_method: String,
    pub payment_intent_id: Option<i32>,
    pub contact_id: Option<i32>,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for StoreOrder {
    const INFO: ModelInfo = ModelInfo {
        name: "StoreOrder",
        table: "store_orders",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "code", pg_type: "varchar", nullable: false },
            Column { name: "status", pg_type: "varchar", nullable: false },
            Column { name: "customer_name", pg_type: "varchar", nullable: false },
            Column { name: "customer_phone", pg_type: "varchar", nullable: false },
            Column { name: "customer_address", pg_type: "varchar", nullable: true },
            Column { name: "note", pg_type: "varchar", nullable: true },
            Column { name: "items", pg_type: "jsonb", nullable: false },
            Column { name: "total", pg_type: "int8", nullable: false },
            Column { name: "payment_method", pg_type: "varchar", nullable: false },
            Column { name: "payment_intent_id", pg_type: "int4", nullable: true },
            Column { name: "contact_id", pg_type: "int4", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `ChannelUsage`, bảng `channel_usage`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct ChannelUsage {
    pub kind: String,
    pub bucket: Timestamp,
    pub count: i32,
}

impl Model for ChannelUsage {
    const INFO: ModelInfo = ModelInfo {
        name: "ChannelUsage",
        table: "channel_usage",
        columns: &[
            Column { name: "kind", pg_type: "varchar", nullable: false },
            Column { name: "bucket", pg_type: "timestamptz", nullable: false },
            Column { name: "count", pg_type: "int4", nullable: false },
        ],
    };
}

/// Model `ChannelEvent`, bảng `channel_events`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct ChannelEvent {
    pub id: i32,
    pub kind: String,
    pub message: String,
    pub meta: Option<JsonValue>,
    pub created_at: Timestamp,
}

impl Model for ChannelEvent {
    const INFO: ModelInfo = ModelInfo {
        name: "ChannelEvent",
        table: "channel_events",
        columns: &[
            Column { name: "id", pg_type: "int4", nullable: false },
            Column { name: "kind", pg_type: "varchar", nullable: false },
            Column { name: "message", pg_type: "text", nullable: false },
            Column { name: "meta", pg_type: "jsonb", nullable: true },
            Column { name: "created_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `TokenBlacklist`, bảng `token_blacklist`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct TokenBlacklist {
    pub user_id: i32,
    pub expires_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Model for TokenBlacklist {
    const INFO: ModelInfo = ModelInfo {
        name: "TokenBlacklist",
        table: "token_blacklist",
        columns: &[
            Column { name: "user_id", pg_type: "int4", nullable: false },
            Column { name: "expires_at", pg_type: "timestamptz", nullable: false },
            Column { name: "updated_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Model `ActiveSession`, bảng `active_sessions`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, sqlx::FromRow)]
pub struct ActiveSession {
    pub user_id: i32,
    pub session_id: String,
    pub started_at: Timestamp,
}

impl Model for ActiveSession {
    const INFO: ModelInfo = ModelInfo {
        name: "ActiveSession",
        table: "active_sessions",
        columns: &[
            Column { name: "user_id", pg_type: "int4", nullable: false },
            Column { name: "session_id", pg_type: "varchar", nullable: false },
            Column { name: "started_at", pg_type: "timestamptz", nullable: false },
        ],
    };
}

/// Mọi model còn dùng (109 model).
pub const MODELS: &[ModelInfo] = &[
    User::INFO,
    Role::INFO,
    UserRole::INFO,
    RolePermission::INFO,
    RbacAuditLog::INFO,
    Team::INFO,
    LoginWifiCheckTarget::INFO,
    Contact::INFO,
    ContactRecentView::INFO,
    Activity::INFO,
    Deal::INFO,
    Project::INFO,
    JobTitle::INFO,
    Employee::INFO,
    EmployeeContract::INFO,
    EmploymentPeriod::INFO,
    ContractTemplate::INFO,
    RecruitmentCandidate::INFO,
    RecruitmentPosition::INFO,
    SalaryRule::INFO,
    SalaryRuleDetail::INFO,
    SalaryComponent::INFO,
    InsuranceSetting::INFO,
    TaxBracket::INFO,
    PayrollTaxSetting::INFO,
    KpiConfig::INFO,
    KpiResult::INFO,
    Payslip::INFO,
    NotificationTemplate::INFO,
    NotificationLog::INFO,
    RevokedSession::INFO,
    UserInvitation::INFO,
    Setting::INFO,
    LeadAiIntent::INFO,
    SettingOption::INFO,
    AuditLog::INFO,
    ApiKey::INFO,
    NewsfeedPost::INFO,
    NewsfeedPostImage::INFO,
    NewsfeedPostLike::INFO,
    NewsfeedPostComment::INFO,
    AttendanceOffice::INFO,
    AttendanceQrSession::INFO,
    AttendanceRecord::INFO,
    AttendanceRequest::INFO,
    Product::INFO,
    ProductCategory::INFO,
    ProductAttributeDef::INFO,
    KanbanBoard::INFO,
    KanbanColumn::INFO,
    KanbanFieldDef::INFO,
    KanbanCard::INFO,
    KanbanCardAssignee::INFO,
    KanbanChecklistItem::INFO,
    KanbanCardAttachment::INFO,
    KanbanCardActivity::INFO,
    PosSettings::INFO,
    PosArea::INFO,
    PosTable::INFO,
    PosModifier::INFO,
    PosShift::INFO,
    PosOrder::INFO,
    PosOrderItem::INFO,
    PosPayment::INFO,
    IntegrationAuditLog::INFO,
    IntegrationEvent::INFO,
    WebhookEndpoint::INFO,
    WebhookDelivery::INFO,
    WebhookInboundSource::INFO,
    WebhookInboundReceipt::INFO,
    OauthClient::INFO,
    OauthAuthorizationCode::INFO,
    OauthToken::INFO,
    AiActionDraft::INFO,
    CustomObject::INFO,
    CustomField::INFO,
    CustomRecord::INFO,
    CustomView::INFO,
    RecordLink::INFO,
    CustomSchemaVersion::INFO,
    ZaloOaConnection::INFO,
    ZaloOaOauthState::INFO,
    ZaloOaThread::INFO,
    ZaloOaMessage::INFO,
    Briefing::INFO,
    FacebookPage::INFO,
    FacebookConversation::INFO,
    FacebookBroadcast::INFO,
    FacebookBroadcastRecipient::INFO,
    FacebookMessage::INFO,
    FacebookComment::INFO,
    FacebookCommentRule::INFO,
    FacebookLeadReceipt::INFO,
    SocialAccount::INFO,
    SocialPost::INFO,
    SocialDraft::INFO,
    SocialRecurrence::INFO,
    SocialQueueSlot::INFO,
    SocialSnippet::INFO,
    SocialMediaAsset::INFO,
    SocialPostTarget::INFO,
    FacebookChatLink::INFO,
    FacebookFlow::INFO,
    FacebookFlowRun::INFO,
    StoreOrder::INFO,
    ChannelUsage::INFO,
    ChannelEvent::INFO,
    TokenBlacklist::INFO,
    ActiveSession::INFO,
];
