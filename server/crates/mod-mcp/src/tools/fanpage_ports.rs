//! Cài `ChatLinksPort` và `FlowsPort` của tool Fanpage (M44b) trên dịch vụ thật của `mod-facebook` (M50). Nối vào
//! [`super::register_fanpage`] ở `trinity-bin`. Lỗi nghiệp vụ 400/404 của dịch vụ thành `ToolError::User` kèm câu nguyên văn
//! (quy ước của port); lỗi khác đi qua [`app_err`].

use std::sync::Arc;

use serde_json::{Map, Value};
use trinity_db::{CompanyRef, TenantConn};
use trinity_kernel::error::AppError;

use super::fanpage::{ChatLinksPort, FlowsPort};
use crate::deps::app_err;
use crate::exec::ToolError;
use crate::protocol::BoxFuture;
use mod_facebook::chat_links::{self, ChatLinkInput, LinkUrls};
use mod_facebook::flows::FlowInput;
use mod_facebook::ingest::FacebookIngest;

/// Dịch vụ nhắn tin Facebook của một máy chủ, dùng chung cho cả hai port.
pub struct FacebookFanpagePorts {
    pub ingest: Arc<FacebookIngest>,
    pub multi_tenant: bool,
}

fn map_err(e: AppError) -> ToolError {
    if let AppError::Http(h) = &e
        && (h.status() == 400 || h.status() == 404)
    {
        let message = match h.body().message {
            trinity_kernel::error::Message::One(s) => s,
            trinity_kernel::error::Message::Many(m) => m.join("; "),
        };
        return ToolError::User(message);
    }
    app_err(e)
}

fn http_err(e: trinity_kernel::error::HttpError) -> ToolError {
    map_err(e.into())
}

impl FacebookFanpagePorts {
    async fn conn(&self, company: CompanyRef) -> Result<TenantConn, ToolError> {
        let t = self
            .ingest
            .db
            .tenant(company)
            .await
            .map_err(|e| ToolError::Internal(e.to_string()))?;
        t.acquire().await.map_err(|e| ToolError::Internal(e.to_string()))
    }

    fn urls(&self, company: CompanyRef) -> LinkUrls {
        LinkUrls::from_env(&self.ingest.env, self.multi_tenant, company)
    }
}

impl ChatLinksPort for FacebookFanpagePorts {
    fn list(&self, company: CompanyRef) -> BoxFuture<'_, Result<Vec<Value>, ToolError>> {
        Box::pin(async move {
            let mut c = self.conn(company).await?;
            let v = chat_links::list(&mut c, &self.urls(company)).await.map_err(map_err)?;
            Ok(v.get("data").and_then(Value::as_array).cloned().unwrap_or_default())
        })
    }

    fn create(&self, company: CompanyRef, user_id: i32, input: Value) -> BoxFuture<'_, Result<Value, ToolError>> {
        Box::pin(async move {
            let input = ChatLinkInput::from_json(&input).map_err(http_err)?;
            let mut c = self.conn(company).await?;
            chat_links::create(&mut c, &input, user_id, &self.urls(company))
                .await
                .map_err(map_err)
        })
    }
}

impl FlowsPort for FacebookFanpagePorts {
    fn list(&self, company: CompanyRef) -> BoxFuture<'_, Result<Vec<Value>, ToolError>> {
        Box::pin(async move { self.ingest.list_flows(company).await.map_err(map_err) })
    }

    fn create(&self, company: CompanyRef, user_id: i32, input: Value) -> BoxFuture<'_, Result<Value, ToolError>> {
        Box::pin(async move {
            let input = FlowInput::from_json(&input).map_err(http_err)?;
            self.ingest.create_flow(company, &input, user_id).await.map_err(map_err)
        })
    }

    fn update(
        &self,
        company: CompanyRef,
        id: i32,
        input: Map<String, Value>,
    ) -> BoxFuture<'_, Result<Value, ToolError>> {
        Box::pin(async move {
            let input = FlowInput::from_json(&Value::Object(input)).map_err(http_err)?;
            self.ingest.update_flow(company, id, &input).await.map_err(map_err)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use trinity_kernel::error::HttpError;

    #[test]
    fn loi_nghiep_vu_thanh_loi_nguoi_dung() {
        let e = map_err(HttpError::bad_request("Chọn Fanpage đã kết nối").into());
        assert!(matches!(e, ToolError::User(m) if m == "Chọn Fanpage đã kết nối"));
        let e = map_err(HttpError::not_found("Không tìm thấy kịch bản").into());
        assert!(matches!(e, ToolError::User(m) if m == "Không tìm thấy kịch bản"));
    }
}
