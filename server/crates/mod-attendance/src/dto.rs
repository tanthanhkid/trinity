//! DTO của M13a. Luật kiểm là metadata THẬT của class-validator (`contracts/dto/schema.json`, chạy qua `trinity_http::validate`,
//! golden khớp `ValidationPipe`); struct chỉ nhận giá trị đã kiểm. Trường PATCH nhận `null`: không gửi = giữ nguyên (`None`),
//! `null` = xoá (`Some(None)`) — chỉ ở cột cho phép; DTO đã chặn `null` ở trường không cho (400).

use serde::{Deserialize, Deserializer};

/// `#[serde(default, deserialize_with = "some_nullable")]`.
fn some_nullable<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// Body `POST /management/attendance/offices` (`CreateOfficeDto`).
#[derive(Debug, Clone, Deserialize)]
pub struct CreateOfficeDto {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub ips: Vec<String>,
    #[serde(default)]
    pub is_active: Option<bool>,
    #[serde(default)]
    pub is_demo: Option<bool>,
}

impl trinity_http::validate::Dto for CreateOfficeDto {
    const NAME: &'static str = "CreateOfficeDto";
}

/// Body `PATCH /management/attendance/offices/:id` (`UpdateOfficeDto`). Chỉ `description` nhận `null` (xoá mô tả).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateOfficeDto {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub description: Option<Option<String>>,
    #[serde(default)]
    pub ips: Option<Vec<String>>,
    #[serde(default)]
    pub is_active: Option<bool>,
    #[serde(default)]
    pub is_demo: Option<bool>,
}

impl trinity_http::validate::Dto for UpdateOfficeDto {
    const NAME: &'static str = "UpdateOfficeDto";
}

/// Body `PATCH /management/attendance/settings` (`UpdateAttendanceSettingsDto`).
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateAttendanceSettingsDto {
    pub work_start: String,
    pub work_end: String,
    pub late_after: String,
    #[serde(default)]
    pub lunch_start: Option<String>,
    #[serde(default)]
    pub lunch_end: Option<String>,
    #[serde(default)]
    pub review_max_hours: Option<f64>,
    #[serde(default)]
    pub half_day_min_hours: Option<f64>,
    #[serde(default)]
    pub full_day_min_hours: Option<f64>,
}

impl trinity_http::validate::Dto for UpdateAttendanceSettingsDto {
    const NAME: &'static str = "UpdateAttendanceSettingsDto";
}

/// Body `PATCH /management/attendance/request-config` (`UpdateRequestConfigDto`).
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateRequestConfigDto {
    pub default_check_in: String,
    pub default_check_out: String,
    pub monthly_forgot_limit: f64,
    pub monthly_late_early_limit: f64,
}

impl trinity_http::validate::Dto for UpdateRequestConfigDto {
    const NAME: &'static str = "UpdateRequestConfigDto";
}

/// Body `PATCH /management/attendance/working-saturdays` (`UpdateWorkingSaturdaysDto`).
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateWorkingSaturdaysDto {
    pub dates: Vec<String>,
}

impl trinity_http::validate::Dto for UpdateWorkingSaturdaysDto {
    const NAME: &'static str = "UpdateWorkingSaturdaysDto";
}
