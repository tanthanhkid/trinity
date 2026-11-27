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

/// Trường chữ của `POST /management/attendance/check-in|check-out` (`DeviceCheckDto`, multipart). Trường `selfie` (`@Allow`) chỉ
/// để qua whitelist; tệp ảnh do lớp multipart tách ra trước khi kiểm.
#[derive(Debug, Clone, Deserialize)]
pub struct DeviceCheckDto {
    pub device_id: String,
    #[serde(default)]
    pub note: Option<String>,
}

impl trinity_http::validate::Dto for DeviceCheckDto {
    const NAME: &'static str = "DeviceCheckDto";
}

/// Body `POST /management/attendance/requests` (`CreateAttendanceRequestDto`). Giờ đề nghị nhận `null` như bỏ trống (`@IsOptional`).
#[derive(Debug, Clone, Deserialize)]
pub struct CreateAttendanceRequestDto {
    pub work_date: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub requested_check_in: Option<String>,
    #[serde(default)]
    pub requested_check_out: Option<String>,
    pub reason: String,
}

impl trinity_http::validate::Dto for CreateAttendanceRequestDto {
    const NAME: &'static str = "CreateAttendanceRequestDto";
}

/// Body `POST /management/attendance/requests/:id/reject` (`RejectRequestDto`).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RejectRequestDto {
    #[serde(default)]
    pub review_note: Option<String>,
}

impl trinity_http::validate::Dto for RejectRequestDto {
    const NAME: &'static str = "RejectRequestDto";
}

/// Query `GET /management/attendance/requests` (`QueryAttendanceRequestsDto`).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct QueryAttendanceRequestsDto {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub page_size: Option<i64>,
    #[serde(default)]
    pub team_id: Option<i64>,
    #[serde(default)]
    pub department: Option<String>,
    #[serde(default)]
    pub job_title_id: Option<i64>,
}

impl trinity_http::validate::Dto for QueryAttendanceRequestsDto {
    const NAME: &'static str = "QueryAttendanceRequestsDto";
}

/// Query `GET /management/attendance` và `GET /workdays-matrix` (`QueryAttendanceDto`).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct QueryAttendanceDto {
    #[serde(default)]
    pub date_from: Option<String>,
    #[serde(default)]
    pub date_to: Option<String>,
    #[serde(default)]
    pub user_id: Option<i64>,
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub page_size: Option<i64>,
    #[serde(default)]
    pub sort_by: Option<String>,
    #[serde(default)]
    pub sort_dir: Option<String>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub team_id: Option<i64>,
    #[serde(default)]
    pub department: Option<String>,
    #[serde(default)]
    pub job_title_id: Option<i64>,
    #[serde(default)]
    pub status: Option<String>,
}

impl trinity_http::validate::Dto for QueryAttendanceDto {
    const NAME: &'static str = "QueryAttendanceDto";
}

/// Query `GET /management/attendance/today` (`QueryTodaySummaryDto`).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct QueryTodaySummaryDto {
    #[serde(default)]
    pub date: Option<String>,
}

impl trinity_http::validate::Dto for QueryTodaySummaryDto {
    const NAME: &'static str = "QueryTodaySummaryDto";
}

/// Body `PATCH /management/attendance/:id` (`PatchAttendanceDto`). Mọi trường là `@IsOptional` nên nhận `null`:
/// không gửi = `None`, `null` = `Some(None)` như `dto.x !== undefined` của bản TS.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct PatchAttendanceDto {
    #[serde(default, deserialize_with = "some_nullable")]
    pub check_in_at: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub check_out_at: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub check_in_note: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub check_out_note: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub total_hours: Option<Option<f64>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub late_minutes: Option<Option<i32>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub status: Option<Option<String>>,
}

impl trinity_http::validate::Dto for PatchAttendanceDto {
    const NAME: &'static str = "PatchAttendanceDto";
}
