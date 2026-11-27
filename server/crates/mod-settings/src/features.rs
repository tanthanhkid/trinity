//! Tính năng của tổ chức, gói dịch vụ và mức dùng (`org-features.service.ts`, `usage.service.ts`, `usage.controller.ts`).

use serde::Serialize;
use serde_json::{Value, json};
use sqlx::{Connection, PgConnection};
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
    Ordered(f.iter().map(|(k, v)| (k, Some(v))).collect())
}

fn update_failed() -> AppError {
    HttpError::new(500, "Không cập nhật được tính năng của tổ chức").into()
}

/// Hệ thống chưa dựng quy trình (`setup_status = chua_dung`) ⇒ mặc định cho khoá thiếu là tắt hết (trừ `integrations`).
/// Lỗi DB trả `Err` (`get` nuốt lỗi và fail-open; ghi thì KHÔNG được ghi lại từ mặc định).
async fn try_defaults(conn: &mut PgConnection) -> Result<Option<OrgFeatures>, AppError> {
    let raw = read_setting(conn, KEY_SETUP).await?;
    Ok((raw.as_deref().map(trim_js) == Some("chua_dung")).then(blank_system_features))
}

/// Cấu hình đã lưu: lỗi DB ⇒ `Err`; JSON rác ⇒ coi như chưa lưu (như `readStored` của Node).
async fn try_stored(conn: &mut PgConnection) -> Result<Value, AppError> {
    Ok(read_setting(conn, KEY_FEATURES)
        .await?
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null))
}

/// Gói hiện tại, lỗi DB ⇒ `Err` (dùng khi ghi). Dòng vắng hoặc rác ⇒ gói mặc định của công ty.
async fn try_plan(conn: &mut PgConnection, ctx: Ctx) -> Result<PlanKey, AppError> {
    Ok(plan_from_setting(
        read_setting(conn, PLAN_SETTING_KEY).await?.as_deref(),
        ctx.company_id,
    ))
}

/// Gói hiện tại cho đường ĐỌC: lỗi đọc ⇒ `custom` (fail-open như `getPlan` của Node).
pub async fn get_plan(conn: &mut PgConnection, ctx: Ctx) -> PlanKey {
    try_plan(conn, ctx).await.unwrap_or(PlanKey::Custom)
}

/// `GET /settings/org-features`: đủ khoá, đã áp gói. Lỗi đọc ⇒ bật hết (fail-open); ghi không bao giờ đi đường này.
pub async fn get(conn: &mut PgConnection, ctx: Ctx) -> Result<Ordered, AppError> {
    let plan = get_plan(conn, ctx).await;
    let read = async {
        let def = try_defaults(conn).await?;
        let stored = try_stored(conn).await?;
        Ok::<_, AppError>(resolve_org_features(&stored, def.as_ref()))
    };
    let features = match read.await {
        Ok(f) => f,
        Err(e) => {
            tracing::error!("getOrgFeatures failed: {e:?}");
            resolve_org_features(&Value::Null, None)
        }
    };
    Ok(ordered(&apply_plan_to_features(&features, plan)))
}

/// Kết quả `PUT /settings/org-features`: `features` là phản hồi; `changed` cho tầng serve gọi `trackProductEvent`
/// (`feature_toggled`, `{feature, enabled}`) sau khi ghi (router `api.rs` gọi qua `trinity_obs::ProductEvents`).
#[derive(Debug, Clone, PartialEq)]
pub struct Updated {
    pub features: Ordered,
    pub changed: Vec<(&'static str, bool)>,
}

/// `PUT /settings/org-features`: cập nhật một phần. Bật khoá do gói quyết định mà gói không có ⇒ 400. `null` đặt lại khoá
/// về mặc định. MỌI lỗi đọc DB ⇒ 500 (không ghi lại từ giá trị mặc định, tránh xoá cấu hình thật vì một lần đọc lỗi).
pub async fn update(
    conn: &mut PgConnection,
    ctx: Ctx,
    dto: &OrgFeaturesInput,
    user_id: i32,
) -> Result<Updated, AppError> {
    let plan = try_plan(conn, ctx).await.map_err(|_| update_failed())?;
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
    let defaults = try_defaults(conn).await.map_err(|_| update_failed())?;
    let stored = try_stored(conn).await.map_err(|_| update_failed())?;
    let mut next = resolve_org_features(&stored, defaults.as_ref());
    let mut nulls: Vec<&'static str> = Vec::new();
    let mut changed = Vec::new();
    for (key, _, _) in ORG_FEATURES {
        match dto.sent(key) {
            Some(Some(v)) => {
                next.set(key, v);
                changed.push((key, v));
            }
            Some(None) => nulls.push(key),
            None => {}
        }
    }
    // JSON.stringify theo thứ tự `ORG_FEATURE_KEYS` (serde_json sắp theo chữ cái nên ghép chuỗi tay); `null` ghi `null`.
    let body = next
        .iter()
        .map(|(k, v)| {
            if nulls.contains(&k) {
                format!("\"{k}\":null")
            } else {
                format!("\"{k}\":{v}")
            }
        })
        .collect::<Vec<_>>()
        .join(",");
    write_setting(conn, KEY_FEATURES, &format!("{{{body}}}"), Some(user_id))
        .await
        .map_err(|_| update_failed())?;
    tracing::info!("Org features updated by user {user_id}: {{{body}}}");
    // Phản hồi: khoá `null` ra `null` (Node trả đúng `next` đã áp gói), trừ khoá bị gói ép tắt.
    let applied = apply_plan_to_features(&next, plan);
    let features = Ordered(
        applied
            .iter()
            .map(|(k, v)| {
                let forced_off = PLAN_GATED_FEATURES.contains(&k) && !def.features.contains(&k);
                (
                    k,
                    if nulls.contains(&k) && !forced_off {
                        None
                    } else {
                        Some(v)
                    },
                )
            })
            .collect(),
    );
    Ok(Updated { features, changed })
}

/// Kết quả [`set_plan`]: tầng serve dùng để gọi `trackProductEvent('plan_changed', user, { plan })`; router `api.rs` gọi.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanChange {
    pub from: PlanKey,
    pub to: PlanKey,
}

/// `PUT /settings/plan` phần ghi: đổi gói và ghi `audit_logs` trong MỘT giao dịch (không có nhật ký thì không đổi). Mở giao dịch
/// ngay trong hàm (là savepoint nếu người gọi đã ở trong giao dịch). Lỗi đọc gói ⇒ lỗi, không giả định `custom`.
pub async fn set_plan(
    conn: &mut PgConnection,
    ctx: Ctx,
    plan: PlanKey,
    user_id: Option<i32>,
    source: &str,
    ip: Option<&str>,
) -> Result<PlanChange, AppError> {
    let mut tx = conn.begin().await.map_err(db)?;
    let from = try_plan(&mut tx, ctx).await?;
    write_setting(&mut tx, PLAN_SETTING_KEY, plan.as_str(), user_id).await?;
    let meta = json!({"from": from.as_str(), "to": plan.as_str(), "source": source});
    sqlx::query("INSERT INTO audit_logs (user_id, action, resource, ip_address, metadata) VALUES ($1, 'update', 'org_plan', $2, $3::text::jsonb)")
        .bind(user_id)
        .bind(ip)
        .bind(meta.to_string())
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    tx.commit().await.map_err(db)?;
    tracing::info!(
        "Org plan {} -> {} ({source}, user {})",
        from.as_str(),
        plan.as_str(),
        user_id.map_or("-".to_owned(), |u| u.to_string())
    );
    Ok(PlanChange { from, to: plan })
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
