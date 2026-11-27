//! DTO của nhân viên (M10). Luật kiểm là metadata THẬT của class-validator (`contracts/dto/schema.json`, chạy qua
//! `trinity_http::validate`, golden khớp `ValidationPipe`); struct ở đây chỉ nhận giá trị đã kiểm. Trường PATCH nhận
//! `null`: không gửi = giữ nguyên (`None`), `null` = xoá (`Some(None)`).

use serde::Deserialize;

use crate::nullable::some_nullable;

/// Query `GET /management/employees` và `/export` (`QueryEmployeesDto`).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct QueryEmployeesDto {
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub page_size: Option<i64>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub department: Option<String>,
    #[serde(default)]
    pub position: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    /// Id team chính thức dạng chuỗi, hoặc `none` = chưa có team.
    #[serde(default)]
    pub team: Option<String>,
    /// `active` | `resigned` | `all`.
    #[serde(default)]
    pub employment_state: Option<String>,
    #[serde(default)]
    pub sort_by: Option<String>,
    #[serde(default)]
    pub sort_dir: Option<String>,
}

impl trinity_http::validate::Dto for QueryEmployeesDto {
    const NAME: &'static str = "QueryEmployeesDto";
}

/// Query `GET /management/employees/hr-stats` (`HrStatsQueryDto`).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct HrStatsQueryDto {
    #[serde(default)]
    pub office_id: Option<i64>,
    #[serde(default)]
    pub department: Option<String>,
    #[serde(default)]
    pub team: Option<String>,
    #[serde(default)]
    pub job_title_id: Option<i64>,
}

impl trinity_http::validate::Dto for HrStatsQueryDto {
    const NAME: &'static str = "HrStatsQueryDto";
}

/// Query `GET /management/employees/birthdays[/export]` (`BirthdayListQueryDto`).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct BirthdayListQueryDto {
    #[serde(default)]
    pub month: Option<i64>,
    #[serde(default)]
    pub office_id: Option<i64>,
    #[serde(default)]
    pub department: Option<String>,
    #[serde(default)]
    pub team: Option<String>,
    #[serde(default)]
    pub job_title_id: Option<i64>,
}

impl trinity_http::validate::Dto for BirthdayListQueryDto {
    const NAME: &'static str = "BirthdayListQueryDto";
}

impl BirthdayListQueryDto {
    pub fn filters(&self) -> HrStatsQueryDto {
        HrStatsQueryDto {
            office_id: self.office_id,
            department: self.department.clone(),
            team: self.team.clone(),
            job_title_id: self.job_title_id,
        }
    }
}

/// Body `POST /management/employees` (`CreateEmployeeDto`). `null` ở trường tuỳ chọn coi như không gửi (như `?? null`).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct CreateEmployeeDto {
    pub email: String,
    pub full_name: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub employee_code: Option<String>,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub team_id: Option<i64>,
    #[serde(default)]
    pub manager_id: Option<i64>,
    #[serde(default)]
    pub insurance_salary: Option<i64>,
    #[serde(default)]
    pub position: Option<String>,
    #[serde(default)]
    pub department: Option<String>,
    #[serde(default)]
    pub gender: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub education_level: Option<String>,
    #[serde(default)]
    pub recruitment_source: Option<String>,
    #[serde(default)]
    pub joined_at: Option<String>,
    #[serde(default)]
    pub salary_rule_id: Option<i64>,
    #[serde(default)]
    pub job_title_id: Option<i64>,
    #[serde(default)]
    pub office_id: Option<i64>,
    #[serde(default)]
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub birth_date: Option<String>,
    #[serde(default)]
    pub id_card_number: Option<String>,
    #[serde(default)]
    pub id_card_issued_date: Option<String>,
    #[serde(default)]
    pub id_card_issued_place: Option<String>,
    #[serde(default)]
    pub permanent_address: Option<String>,
    #[serde(default)]
    pub current_address: Option<String>,
    #[serde(default)]
    pub bank_account_number: Option<String>,
    #[serde(default)]
    pub bank_name: Option<String>,
    #[serde(default)]
    pub bank_account_holder: Option<String>,
}

impl trinity_http::validate::Dto for CreateEmployeeDto {
    const NAME: &'static str = "CreateEmployeeDto";
}

macro_rules! patch_dto {
    ($($(#[$m:meta])* $f:ident : $t:ty),* $(,)?) => {
        /// Body `PATCH /management/employees/:id` (`UpdateEmployeeDto`).
        #[derive(Debug, Clone, Default, Deserialize)]
        pub struct UpdateEmployeeDto {
            $(
                #[serde(default, deserialize_with = "some_nullable")]
                $(#[$m])*
                pub $f: Option<Option<$t>>,
            )*
        }
    };
}

patch_dto! {
    full_name: String,
    phone: String,
    employee_code: String,
    team_id: i64,
    manager_id: i64,
    insurance_salary: i64,
    position: String,
    department: String,
    gender: String,
    status: String,
    education_level: String,
    recruitment_source: String,
    joined_at: String,
    salary_rule_id: i64,
    job_title_id: i64,
    office_id: i64,
    avatar_url: String,
    birth_date: String,
    id_card_number: String,
    id_card_issued_date: String,
    id_card_issued_place: String,
    permanent_address: String,
    current_address: String,
    bank_account_number: String,
    bank_name: String,
    bank_account_holder: String,
}

impl trinity_http::validate::Dto for UpdateEmployeeDto {
    const NAME: &'static str = "UpdateEmployeeDto";
}
