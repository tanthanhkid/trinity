//! DTO của hợp đồng lao động (M11). Luật kiểm là metadata THẬT của class-validator (`contracts/dto/schema.json`, chạy qua
//! `trinity_http::validate`, golden khớp `ValidationPipe`); struct ở đây chỉ nhận giá trị đã kiểm. Trường PATCH nhận `null`:
//! không gửi = giữ nguyên (`None`), `null` = xoá (`Some(None)`).

use serde::Deserialize;

use crate::nullable::some_nullable;

/// Body `POST /management/contracts` (`CreateContractDto`). `file_url` được nhận nhưng KHÔNG dùng: tệp chỉ đặt qua upload.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateContractDto {
    pub employee_id: i64,
    #[serde(default)]
    pub contract_type: Option<String>,
    pub signed_date: String,
    #[serde(default)]
    pub end_date: Option<String>,
    #[serde(default)]
    pub file_url: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub is_terminated: Option<bool>,
}

impl trinity_http::validate::Dto for CreateContractDto {
    const NAME: &'static str = "CreateContractDto";
}

/// Body `PATCH /management/contracts/:id` (`UpdateContractDto`); không đổi được nhân viên.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateContractDto {
    #[serde(default)]
    pub contract_type: Option<String>,
    #[serde(default)]
    pub signed_date: Option<String>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub end_date: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub file_url: Option<Option<String>>,
    #[serde(default, deserialize_with = "some_nullable")]
    pub notes: Option<Option<String>>,
    #[serde(default)]
    pub is_terminated: Option<bool>,
}

impl trinity_http::validate::Dto for UpdateContractDto {
    const NAME: &'static str = "UpdateContractDto";
}

/// Query `GET /management/contracts` (`QueryContractsDto`).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct QueryContractsDto {
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
    #[serde(default)]
    pub contract_type: Option<String>,
    #[serde(default)]
    pub employment_status: Option<String>,
    /// Id team chính thức (bảng `teams`) dạng chuỗi.
    #[serde(default)]
    pub team: Option<String>,
    #[serde(default)]
    pub sort_by: Option<String>,
    #[serde(default)]
    pub sort_dir: Option<String>,
}

impl trinity_http::validate::Dto for QueryContractsDto {
    const NAME: &'static str = "QueryContractsDto";
}

/// Query `GET /management/contracts/stats` (`QueryContractStatsDto`). `team` ở đây là `team_lead_id` dạng chuỗi.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct QueryContractStatsDto {
    #[serde(default)]
    pub date_from: Option<String>,
    #[serde(default)]
    pub date_to: Option<String>,
    #[serde(default)]
    pub department: Option<String>,
    #[serde(default)]
    pub team: Option<String>,
    #[serde(default)]
    pub employment_status: Option<String>,
}

impl trinity_http::validate::Dto for QueryContractStatsDto {
    const NAME: &'static str = "QueryContractStatsDto";
}
