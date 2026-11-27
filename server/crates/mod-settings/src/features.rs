//! Tính năng của tổ chức, gói dịch vụ và mức dùng (`org-features.service.ts`, `usage.service.ts`, `usage.controller.ts`).

use serde::Serialize;
use serde_json::Value;
use sqlx::PgConnection;
use subtle::ConstantTimeEq;
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::vi::trim_js;
use trinity_rbac::plan::{
    ORG_FEATURES, OrgFeatures, PLAN_GATED_FEATURES, PLAN_KEYS, PlanKey, apply_plan_to_features, blank_system_features,
    plan_from_setting, resolve_org_features,
};

use crate::validate::OrgFeaturesInput;
use crate::{Ctx, Ordered, db, read_setting, write_setting};

const KEY_FEATURES: &str = "org_features";
/// Gói dịch vụ của tổ chức (`PLAN_SETTING_KEY`).
pub const PLAN_SETTING_KEY: &str = "org_plan";
const KEY_SETUP: &str = "setup_status";

/// Header và biến môi trường khoá đổi gói: chỉ Trinity giữ token này.
pub const PLAN_TOKEN_HEADER: &str = "x-trinity-plan-token";
pub const PLAN_TOKEN_ENV: &str = "TRINITY_PLAN_ADMIN_TOKEN";

/// `verifyPlanToken`: so khớp thời gian không phụ thuộc nội dung; chưa cấu hình (rỗng) ⇒ luôn sai (endpoint khoá với mọi người).
pub fn verify_plan_token(provided: Option<&str>, expected: Option<&str>) -> bool {
    let (Some(p), Some(e)) = (provided, expected) else {
        return false;
    };
    if e.is_empty() || p.is_empty() {
        return false;
    }
    if p.len() != e.len() {
        let _ = e.as_bytes().ct_eq(e.as_bytes());
        return false;
    }
    bool::from(p.as_bytes().ct_eq(e.as_bytes()))
}

/// Câu 403 của `PlanTokenGuard`.
pub fn plan_token_denied() -> HttpError {
    HttpError::forbidden("Chỉ Trinity đổi được gói dịch vụ. Liên hệ Trinity để nâng/hạ gói.")
}

fn ordered(f: &OrgFeatures) -> Ordered {
    Ordered(f.iter().collect())
}

/// Hệ thống chưa dựng quy trình (`setup_status = chua_dung`) ⇒ mặc định cho khoá thiếu là tắt hết (trừ `integrations`).
async fn defaults(conn: &mut PgConnection) -> Result<Option<OrgFeatures>, AppError> {
    let raw = read_setting(conn, KEY_SETUP).await.unwrap_or(None);
    Ok((raw.as_deref().map(trim_js) == Some("chua_dung")).then(blank_system_features))
}

async fn read_stored(conn: &mut PgConnection) -> Value {
    read_setting(conn, KEY_FEATURES)
        .await
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

/// Gói hiện tại; dòng vắng hoặc rác ⇒ gói mặc định của công ty; lỗi đọc ⇒ `custom`.
pub async fn get_plan(conn: &mut PgConnection, ctx: Ctx) -> PlanKey {
    match read_setting(conn, PLAN_SETTING_KEY).await {
        Ok(raw) => plan_from_setting(raw.as_deref(), ctx.company_id),
        Err(_) => PlanKey::Custom,
    }
}

/// `GET /settings/org-features`: đủ khoá, đã áp gói. Lỗi đọc ⇒ bật hết (fail-open).
pub async fn get(conn: &mut PgConnection, ctx: Ctx) -> Result<Ordered, AppError> {
    let plan = get_plan(conn, ctx).await;
    let def = defaults(conn).await?;
    let features = resolve_org_features(&read_stored(conn).await, def.as_ref());
    Ok(ordered(&apply_plan_to_features(&features, plan)))
}

/// `PUT /settings/org-features`: cập nhật một phần. Bật khoá do gói quyết định mà gói không có ⇒ 400.
pub async fn update(
    conn: &mut PgConnection,
    ctx: Ctx,
    dto: &OrgFeaturesInput,
    user_id: i32,
) -> Result<Ordered, AppError> {
    let plan = get_plan(conn, ctx).await;
    let def = plan.def();
    for key in PLAN_GATED_FEATURES {
        if dto.get(key) == Some(true) && !def.features.contains(&key) {
            return Err(HttpError::bad_request(format!(
                "Gói \"{}\" không có tính năng này. Nâng gói để bật.",
                def.label
            ))
            .into());
        }
    }
    let defaults = defaults(conn).await?;
    let mut next = resolve_org_features(&read_stored(conn).await, defaults.as_ref());
    for (key, _, _) in ORG_FEATURES {
        if let Some(v) = dto.get(key) {
            next.set(key, v);
        }
    }
    // JSON.stringify theo thứ tự `ORG_FEATURE_KEYS` (serde_json sắp theo chữ cái nên ghép chuỗi tay).
    let body = next
        .iter()
        .map(|(k, v)| format!("\"{k}\":{v}"))
        .collect::<Vec<_>>()
        .join(",");
    write_setting(conn, KEY_FEATURES, &format!("{{{body}}}"), Some(user_id))
        .await
        .map_err(|_| AppError::from(HttpError::new(500, "Không cập nhật được tính năng của tổ chức")))?;
    tracing::info!("Org features updated by user {user_id}: {{{body}}}");
    Ok(ordered(&apply_plan_to_features(&next, plan)))
}

/// `PUT /settings/plan` phần ghi: đổi gói và ghi `audit_logs` TRONG CÙNG giao dịch (không có nhật ký thì không đổi).
/// Người gọi truyền kết nối đã mở giao dịch (hoặc chấp nhận hai câu lệnh liên tiếp).
pub async fn set_plan(
    conn: &mut PgConnection,
    ctx: Ctx,
    plan: PlanKey,
    user_id: Option<i32>,
    source: &str,
    ip: Option<&str>,
) -> Result<PlanKey, AppError> {
    let from = get_plan(conn, ctx).await;
    write_setting(conn, PLAN_SETTING_KEY, plan.as_str(), user_id).await?;
    let meta = format!(
        "{{\"from\":\"{}\",\"to\":\"{}\",\"source\":\"{}\"}}",
        from.as_str(),
        plan.as_str(),
        source
    );
    sqlx::query("INSERT INTO audit_logs (user_id, action, resource, ip_address, metadata) VALUES ($1, 'update', 'org_plan', $2, $3::text::jsonb)")
        .bind(user_id)
        .bind(ip)
        .bind(meta)
        .execute(conn)
        .await
        .map_err(db)?;
    tracing::info!(
        "Org plan {} -> {} ({source}, user {})",
        from.as_str(),
        plan.as_str(),
        user_id.map_or("-".to_owned(), |u| u.to_string())
    );
    Ok(plan)
}

/// Phản hồi `GET /settings/usage` và `PUT /settings/plan`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Usage {
    pub plan: &'static str,
    pub plan_label: &'static str,
    /// `null` = không giới hạn.
    pub max_users: Option<u32>,
    pub active_users: i64,
    pub features: Ordered,
}

pub async fn usage_summary(conn: &mut PgConnection, ctx: Ctx) -> Result<Usage, AppError> {
    let plan = get_plan(conn, ctx).await;
    let def = plan.def();
    let active_users: i64 =
        sqlx::query_scalar("SELECT count(*) FROM users WHERE status = 'active' AND deleted_at IS NULL")
            .fetch_one(&mut *conn)
            .await
            .map_err(db)?;
    let features = get(conn, ctx).await?;
    Ok(Usage {
        plan: plan.as_str(),
        plan_label: def.label,
        max_users: def.max_users,
        active_users,
        features,
    })
}

/// `isPlanKey` + câu 400 của `PUT /settings/plan`.
pub fn parse_plan(v: Option<&Value>) -> Result<PlanKey, HttpError> {
    v.and_then(Value::as_str).and_then(PlanKey::parse).ok_or_else(|| {
        let keys: Vec<&str> = PLAN_KEYS.iter().map(|k| k.as_str()).collect();
        HttpError::bad_request(format!("Gói không hợp lệ. Chọn một trong: {}", keys.join(", ")))
    })
}
