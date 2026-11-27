//! `GET /reports/dashboard-channels`: kênh đã kết nối (Fanpage, Zalo OA, kênh đăng bài, trang bán hàng), mỗi kênh một trạng
//! thái và số liệu hôm nay (chuyển từ `dashboard-channels.service.ts`). Chỉ trả nhóm kênh mà tính năng đang bật VÀ người xem
//! có quyền liên quan; không lộ khoá/token.

use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_rbac::plan::{
    OrgFeatures, PlanKey, apply_plan_to_features, blank_system_features, plan_from_setting, resolve_org_features,
};
use trinity_rbac::{Scope, can};

use crate::period::{VnRange, today_range};
use crate::{Actor, Ctx, R, db, now};

const INTEGRATIONS: &str = "/connections";
const ORDER: [&str; 4] = ["facebook_page", "zalo_oa", "social", "store"];
/// `SOCIAL_NETWORKS`: mạng còn hỗ trợ đăng bài.
const SOCIAL_NETWORKS: [&str; 1] = ["facebook"];

fn rank(kind: &str) -> usize {
    ORDER.iter().position(|k| *k == kind).unwrap_or(usize::MAX)
}

/// `OrgFeaturesService.get`: tính năng của tổ chức (đã tính gói). Lỗi đọc từng phần như bản TS: không đọc được gói ⇒ gói
/// `custom`; không đọc được `setup_status` ⇒ coi như đã dựng; không đọc được hoặc không parse được `org_features` ⇒ mặc định
/// bật hết (bỏ qua cả gói).
pub async fn load_features(conn: &mut PgConnection, company_id: i32) -> OrgFeatures {
    async fn setting(conn: &mut PgConnection, k: &str) -> Result<Option<String>, sqlx::Error> {
        sqlx::query_scalar("SELECT value FROM settings WHERE key = $1")
            .bind(k)
            .fetch_optional(&mut *conn)
            .await
    }
    let plan: PlanKey = match setting(conn, "org_plan").await {
        Ok(raw) => plan_from_setting(raw.as_deref(), Some(company_id)),
        Err(e) => {
            tracing::error!("getPlan failed: {e}");
            PlanKey::Custom
        }
    };
    let stored = match setting(conn, "org_features").await {
        Ok(None) => Ok(Value::Null),
        Ok(Some(s)) if s.is_empty() => Ok(Value::Null),
        Ok(Some(s)) => serde_json::from_str::<Value>(&s).map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    let setup = match setting(conn, "setup_status").await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("đọc setup_status lỗi: {e}");
            None
        }
    };
    let Ok(raw) = stored else {
        tracing::error!("getOrgFeatures failed: không đọc được org_features");
        return resolve_org_features(&Value::Null, None);
    };
    let blank = blank_system_features();
    let defaults = (setup.as_deref().map(str::trim) == Some("chua_dung")).then_some(&blank);
    apply_plan_to_features(&resolve_org_features(&raw, defaults), plan)
}

type Section = (Vec<Value>, Vec<Value>);

pub async fn get(ctx: &Ctx, actor: &Actor) -> R<Value> {
    get_at(ctx, actor, now()).await
}

pub async fn get_at(ctx: &Ctx, actor: &Actor, at: DateTime<Utc>) -> R<Value> {
    let mut c = ctx.conn(actor.company).await?;
    let f = load_features(&mut c, actor.company.id()).await;
    let any = |p: &[&str]| p.iter().any(|x| can(&actor.grants, x, None));
    let org_wide_deals = any(&["integrations.webhooks"]) || can(&actor.grants, "deals.view", Some(Scope::All));
    let on = |k: &str| f.get(k) != Some(false);
    let today = today_range(at);
    let mut channels: Vec<Value> = Vec::new();
    let mut available: Vec<Value> = Vec::new();
    let mut add = |name: &str, r: R<Section>| match r {
        Ok((c, a)) => {
            channels.extend(c);
            available.extend(a);
        }
        Err(e) => tracing::warn!("Kênh Tổng quan lỗi ({name}): {e}"),
    };
    if on("facebook_page") && any(&["integrations.webhooks"]) {
        add("facebook_page", facebook(&mut c, today).await);
    }
    if on("zalo_oa") && any(&["integrations.webhooks", "contacts.update"]) {
        add("zalo_oa", zalo(&mut c, today).await);
    }
    if on("social_posting") && any(&["social.post"]) {
        add("social", social(&mut c, today).await);
    }
    if on("online_store") && (any(&["pos.manage"]) || org_wide_deals) {
        add("store", store(&mut c, today).await);
    }
    let kind = |v: &Value| rank(v.get("kind").and_then(Value::as_str).unwrap_or(""));
    channels.sort_by_key(kind);
    available.sort_by_key(kind);
    Ok(json!({ "channels": channels, "available": available }))
}

async fn facebook(c: &mut PgConnection, t: VnRange) -> R<Section> {
    type Page = (i32, String, String, bool, Option<String>, bool, Option<String>);
    let pages: Vec<Page> = sqlx::query_as(
        "SELECT id, page_id, name, is_active, token_status, subscribed, token_enc FROM facebook_pages ORDER BY id ASC LIMIT 20",
    )
    .fetch_all(&mut *c)
    .await
    .map_err(db)?;
    let mut available = Vec::new();
    if pages.is_empty() {
        available.push(json!({ "kind": "facebook_page", "label": "Fanpage Facebook", "href": format!("{INTEGRATIONS}?muc=facebook") }));
        return Ok((Vec::new(), available));
    }
    let ids: Vec<String> = pages.iter().map(|p| p.1.clone()).collect();
    let inbound: Vec<(String, i64)> = sqlx::query_as(
        "SELECT cv.page_id, count(*) FROM facebook_messages m JOIN facebook_conversations cv ON cv.id = m.conversation_id
         WHERE m.direction = 'in' AND m.sent_at >= $1 AND m.sent_at < $2 AND cv.page_id = ANY($3) GROUP BY cv.page_id",
    )
    .bind(t.start)
    .bind(t.end)
    .bind(&ids)
    .fetch_all(&mut *c)
    .await
    .map_err(db)?;
    let comments: Vec<(String, i64)> = sqlx::query_as(
        "SELECT page_id, count(*) FROM facebook_comments WHERE commented_at >= $1 AND commented_at < $2 AND page_id = ANY($3) GROUP BY page_id",
    )
    .bind(t.start)
    .bind(t.end)
    .bind(&ids)
    .fetch_all(&mut *c)
    .await
    .map_err(db)?;
    let soc: Vec<(String, String)> = sqlx::query_as(
        "SELECT external_id, status FROM social_accounts WHERE network = 'facebook' AND external_id = ANY($1) ORDER BY id ASC",
    )
    .bind(&ids)
    .fetch_all(&mut *c)
    .await
    .map_err(db)?;
    let mut channels = Vec::new();
    for (id, page_id, name, active, token_status, subscribed, token_enc) in &pages {
        let broken = matches!(token_status.as_deref(), Some("invalid" | "expired"));
        let state = if !active {
            "off"
        } else if broken || !subscribed {
            "attention"
        } else {
            "ok"
        };
        let cm = comments.iter().find(|x| &x.0 == page_id).map_or(0, |x| x.1);
        let mut note = if state == "off" {
            if token_enc.as_deref().is_some_and(|s| !s.is_empty()) {
                "Đã tắt"
            } else {
                "Đã ngắt — kết nối lại để bật"
            }
        } else if broken {
            "Cần kết nối lại"
        } else if !subscribed {
            "Chưa nhận tin nhắn"
        } else {
            "Đang nhận tin"
        }
        .to_owned();
        let posting = soc
            .iter()
            .rev()
            .find(|x| &x.0 == page_id)
            .map(|x| if x.1 == "disabled" { "removed" } else { "on" });
        if state == "ok" && posting == Some("on") {
            note.push_str(" · đăng bài được");
        }
        if cm > 0 {
            note.push_str(&format!(" · {cm} bình luận hôm nay"));
        }
        channels.push(json!({
            "key": format!("facebook_page:{id}"), "kind": "facebook_page", "network": "facebook", "name": name, "state": state, "note": note,
            "today": { "label": "tin nhắn mới", "value": inbound.iter().find(|x| &x.0 == page_id).map_or(0, |x| x.1) },
            "href": format!("{INTEGRATIONS}?muc=facebook"), "posting": posting,
        }));
    }
    Ok((channels, available))
}

async fn zalo(c: &mut PgConnection, t: VnRange) -> R<Section> {
    let conns: Vec<(i32, String, String)> =
        sqlx::query_as("SELECT id, oa_id, status FROM zalo_oa_connections ORDER BY id ASC LIMIT 5")
            .fetch_all(&mut *c)
            .await
            .map_err(db)?;
    let mut available = Vec::new();
    if conns.is_empty() {
        available.push(json!({ "kind": "zalo_oa", "label": "Zalo OA", "href": format!("{INTEGRATIONS}?muc=zalo-oa") }));
    }
    let mut channels = Vec::new();
    for (id, oa_id, status) in conns {
        let inbound: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM zalo_oa_messages m JOIN zalo_oa_threads th ON th.id = m.thread_id
             WHERE m.direction = 'in' AND m.created_at >= $1 AND m.created_at < $2 AND th.oa_id = $3",
        )
        .bind(t.start)
        .bind(t.end)
        .bind(&oa_id)
        .fetch_one(&mut *c)
        .await
        .map_err(db)?;
        let state = match status.as_str() {
            "active" => "ok",
            "disconnected" => "off",
            _ => "attention",
        };
        let note = match state {
            "ok" => "Đang nhận tin",
            "off" => "Đã ngắt kết nối",
            _ => "Cần kết nối lại",
        };
        channels.push(json!({
            "key": format!("zalo_oa:{id}"), "kind": "zalo_oa", "network": "zalo", "name": "Zalo OA", "state": state, "note": note,
            "today": { "label": "tin nhắn mới", "value": inbound }, "href": format!("{INTEGRATIONS}?muc=zalo-oa"),
        }));
    }
    Ok((channels, available))
}

async fn social(c: &mut PgConnection, t: VnRange) -> R<Section> {
    let networks: Vec<String> = SOCIAL_NETWORKS.iter().map(|s| (*s).to_owned()).collect();
    // Tài khoản đăng bài của một Fanpage đã có thẻ Page ở nhóm facebook_page (kèm `posting`) ⇒ không đếm thành kênh riêng.
    let all: Vec<(i32, String, String, String, bool)> = sqlx::query_as(
        "SELECT a.id, a.network, a.name, a.status,
                (a.network = 'facebook' AND EXISTS (SELECT 1 FROM facebook_pages p WHERE p.page_id = a.external_id))
           FROM social_accounts a WHERE a.network = ANY($1) ORDER BY a.id ASC LIMIT 20",
    )
    .bind(&networks)
    .fetch_all(&mut *c)
    .await
    .map_err(db)?;
    let mut available = Vec::new();
    let accounts: Vec<(i32, String, String, String)> = all
        .iter()
        .filter(|a| !a.4)
        .map(|a| (a.0, a.1.clone(), a.2.clone(), a.3.clone()))
        .collect();
    if all.is_empty() {
        available.push(json!({ "kind": "social", "label": "Kênh đăng bài (Fanpage)", "href": "/social?tab=channels" }));
    }
    let ids: Vec<i32> = accounts.iter().map(|a| a.0).collect();
    let published: Vec<(i32, i64)> = sqlx::query_as(
        "SELECT account_id, count(*) FROM social_post_targets WHERE status = 'published' AND published_at >= $1 AND published_at < $2 AND account_id = ANY($3) GROUP BY account_id",
    )
    .bind(t.start)
    .bind(t.end)
    .bind(&ids)
    .fetch_all(&mut *c)
    .await
    .map_err(db)?;
    let mut channels = Vec::new();
    for (id, network, name, status) in accounts {
        let state = match status.as_str() {
            "active" => "ok",
            "disabled" => "off",
            _ => "attention",
        };
        let label = if network == "facebook" {
            "Fanpage"
        } else {
            network.as_str()
        };
        let note = match state {
            "ok" => format!("Đăng bài lên {label}"),
            "off" => "Đã tắt".to_owned(),
            _ => "Cần liên kết lại".to_owned(),
        };
        channels.push(json!({
            "key": format!("social:{id}"), "kind": "social", "network": network, "name": name, "state": state, "note": note,
            "today": { "label": "bài đã đăng", "value": published.iter().find(|x| x.0 == id).map_or(0, |x| x.1) },
            "href": "/social?tab=channels",
        }));
    }
    Ok((channels, available))
}

async fn store(c: &mut PgConnection, t: VnRange) -> R<Section> {
    let row: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'online_store'")
        .fetch_optional(&mut *c)
        .await
        .map_err(db)?;
    let store: Value = row.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
    let text = |k: &str| {
        store
            .get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    if text("slug").is_none() {
        return Ok((
            Vec::new(),
            vec![
                json!({ "kind": "store", "label": "Trang bán hàng", "href": format!("{INTEGRATIONS}?muc=ban-online") }),
            ],
        ));
    }
    let orders: i64 =
        sqlx::query_scalar("SELECT count(*) FROM store_orders WHERE created_at >= $1 AND created_at < $2")
            .bind(t.start)
            .bind(t.end)
            .fetch_one(&mut *c)
            .await
            .map_err(db)?;
    let published = match store.get("published") {
        Some(Value::Bool(b)) => *b,
        Some(Value::Null) | None => false,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    };
    let channel = json!({
        "key": "store", "kind": "store", "network": "store", "name": text("name").unwrap_or_else(|| "Trang bán hàng".to_owned()),
        "state": if published { "ok" } else { "off" }, "note": if published { "Đang mở bán" } else { "Chưa mở bán" },
        "today": { "label": "đơn mới", "value": orders }, "href": format!("{INTEGRATIONS}?muc=ban-online"),
    });
    Ok((vec![channel], Vec::new()))
}
