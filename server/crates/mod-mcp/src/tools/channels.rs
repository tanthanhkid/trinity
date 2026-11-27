//! Ba tool đọc về kênh (feature-tools.ts): `get_connected_channels`, `get_channel_limits`, `get_client_ip_status`. Gọi lại đúng hàm
//! của route tương ứng: khối "Kênh đã kết nối" (`mod_reports::channels::get`), `ChannelGuard::status`/`alerts` (route
//! `settings/channel-guard`) và `ClientIpResolver::warning` (route `settings/client-ip/alerts`). Chỉ đọc, không có tool xoá.

use std::sync::Arc;

use serde_json::{Value, json};
use trinity_http::edge::client_ip::ClientIpResolver;
use trinity_rbac::can;

use super::wrapped;
use crate::deps::{app_err, to_json};
use crate::exec::{ToolCtx, ToolError, ToolOutput};
use crate::protocol::BoxFuture;
use mod_channel_guard::ChannelGuard;

/// Phụ thuộc riêng của nhóm (không nằm trong `ToolDeps`).
pub struct ChannelsDeps {
    pub guard: ChannelGuard,
    pub client_ip: Arc<ClientIpResolver>,
}

/// Công ty vận hành máy chủ là công ty 1 (như route `settings/client-ip/alerts`).
const OPERATOR_COMPANY: i32 = 1;

/// Dữ liệu `get_client_ip_status`: chỉ quản trị của công ty vận hành nhận câu cảnh báo.
fn client_ip_data(operator: bool, warning: Option<String>) -> Value {
    json!({ "warning": if operator { warning } else { None } })
}

pub fn get_connected_channels<'a>(
    _state: &'a ChannelsDeps,
    _args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let actor = ctx.deps.report_actor(ctx.principal);
        let data = mod_reports::channels::get(&ctx.deps.reports, &actor)
            .await
            .map_err(app_err)?;
        wrapped(&data)
    })
}

pub fn get_channel_limits<'a>(
    state: &'a ChannelsDeps,
    _args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let p = ctx.principal;
        // Như màn hình: quản trị (`settings.features`) xem đủ hạn mức, mức đã dùng, sự kiện; người khác chỉ thấy cảnh báo.
        let data = if can(&p.grants, "settings.features", None) {
            to_json(&state.guard.status(p.company).await.map_err(app_err)?)?
        } else {
            to_json(&state.guard.alerts(p.company).await.map_err(app_err)?)?
        };
        wrapped(&data)
    })
}

pub fn get_client_ip_status<'a>(
    state: &'a ChannelsDeps,
    _args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let operator = ctx.principal.company.id() == OPERATOR_COMPANY;
        wrapped(&client_ip_data(operator, state.client_ip.warning()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canh_bao_ip_chi_cho_cong_ty_van_hanh() {
        let w = Some("cảnh báo".to_owned());
        assert_eq!(client_ip_data(true, w.clone()), json!({ "warning": "cảnh báo" }));
        assert_eq!(client_ip_data(false, w), json!({ "warning": null }));
        assert_eq!(client_ip_data(true, None), json!({ "warning": null }));
    }
}
