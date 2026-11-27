//! Tool đăng bài, phần đã có nền ở Rust (M44a một phần): `list_social_accounts`, `enable_social_account`, `list_social_media`,
//! `upload_social_media` (`social-tools.ts`). Dùng chính `mod-social` (tài khoản M53a, thư viện media M53b). Tính năng tổ chức
//! `social_posting` phải bật (`OrgFeaturesService.isEnabled`: chỉ `false` tường minh mới tắt).
//!
//! Chưa có (chờ M42 khung ghi, M54b/M55b dịch vụ bài/nháp/hàng đợi/lặp): 12 tool đọc/ghi bài, nháp, mẫu chữ, khung giờ và 9 tool
//! "hành động" (6 đăng bài + 3 bài lặp, có `confirmed_by_user`). Phụ thuộc `SocialDeps` đưa vào lúc đăng ký (không thêm trường vào
//! `ToolDeps`) nên không đụng chỗ dựng `ToolDeps` của serve/test.

use std::sync::Arc;

use mod_facebook::config::Env;
use mod_social::media::{self, LibraryItem, LibraryQuery, MediaCtx, MediaStore};
use serde_json::{Value, json};
use trinity_db::types::Timestamp;
use trinity_kernel::error::{AppError, Message};

use super::wrapped;
use crate::args::{clamp_limit, opt_int, opt_str};
use crate::deps::app_err;
use crate::exec::{ToolCtx, ToolError, ToolOutput, ToolRegistry, ToolRunner, ToolSpec};
use crate::protocol::BoxFuture;

/// Kho tệp và nguồn env của tính năng đăng bài (do tầng `serve` dựng, cùng bản với router `/social`).
pub struct SocialDeps {
    pub store: MediaStore,
    pub env: Env,
}

type RunFn = for<'a> fn(&'a SocialDeps, &'a Value, &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>>;

struct SocialTool {
    deps: Arc<SocialDeps>,
    run: RunFn,
}

impl ToolRunner for SocialTool {
    fn run<'a>(&'a self, args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        (self.run)(&self.deps, args, ctx)
    }
}

/// Đăng ký 4 tool đăng bài đã có nền vào `r`.
pub fn register_social(r: &mut ToolRegistry, deps: Arc<SocialDeps>) {
    let mut reg = |name: &'static str, scope: Option<&'static str>, permissions: &'static [&'static str], run: RunFn| {
        r.register(ToolSpec {
            name,
            scope,
            permissions,
            runner: Arc::new(SocialTool {
                deps: deps.clone(),
                run,
            }),
        });
    };
    reg("list_social_accounts", None, &["social.post"], list_social_accounts);
    reg("list_social_media", None, &["social.post"], list_social_media);
    reg("upload_social_media", Some("crm.write"), &["social.post"], upload_social_media);
    reg("enable_social_account", Some("crm.write"), &["social.manage"], enable_social_account);
}

/// Lỗi < 500 (và thoả `as_user`) ⇒ `ToolUserError` giữ nguyên câu; còn lại theo `app_err`.
fn user_if(e: AppError, as_user: impl Fn(u16) -> bool) -> ToolError {
    let (status, body) = e.response(true);
    let message = match body.message {
        Message::One(s) => s,
        Message::Many(m) => m.join("; "),
    };
    if as_user(status) {
        return ToolError::User(message);
    }
    match status {
        404 => ToolError::NotFound,
        s => ToolError::Http { status: s, message },
    }
}

const OFF: &str = "Tính năng \"Đăng đa kênh\" đang tắt (Cài đặt › Tính năng). / Social posting is turned off for this workspace.";

/// Tính năng `social_posting` đang bật (chỉ `false` tường minh mới tắt).
async fn ensure_enabled(ctx: &ToolCtx<'_>) -> Result<(), ToolError> {
    let (p, deps) = (ctx.principal, ctx.deps);
    let settings = deps.settings_ctx(p);
    let mut conn = deps.conn(p.company).await?;
    let f = mod_settings::features::get(&mut conn, settings)
        .await
        .map_err(app_err)?;
    if f.0.iter().any(|(k, v)| *k == "social_posting" && *v == Some(false)) {
        return Err(ToolError::User(OFF.to_owned()));
    }
    Ok(())
}

/// Giờ Việt Nam dạng ISO có `+07:00` (`vnIso`), đọc thẳng ra giờ địa phương.
pub(crate) fn vn_iso(t: &Timestamp) -> String {
    let local = t.0 + chrono::Duration::hours(7);
    format!("{}+07:00", local.format("%Y-%m-%dT%H:%M:%S"))
}

fn manage_url(base: &str) -> String {
    format!("{base}/social?tab=channels")
}

fn media_for_ai(m: &LibraryItem, base: &str) -> Value {
    json!({
        "media_id": m.id,
        "media_key": m.key,
        "type": m.r#type,
        "name": m.name,
        "size_kb": (f64::from(m.size) / 1024.0).round() as i64,
        "uploaded_at": vn_iso(&m.created_at),
        "preview_url": format!("{base}/social?tab=library&media={}", m.id),
    })
}

fn list_social_accounts<'a>(
    s: &'a SocialDeps,
    _args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        ensure_enabled(ctx).await?;
        let mut conn = ctx.deps.conn(ctx.principal.company).await?;
        let accounts = mod_social::accounts::list(&mut conn).await.map_err(app_err)?;
        let rows: Vec<Value> = accounts
            .iter()
            .map(|a| {
                let mut o = json!({
                    "account_id": a.id,
                    "network": a.network,
                    "name": a.name,
                    "status": a.status,
                    "removed": a.removed.unwrap_or(false),
                });
                if a.network == "facebook" {
                    o["inbox"] = json!(a.inbox.flatten());
                }
                o["error"] = json!(a.last_error);
                o
            })
            .collect();
        let networks: Vec<Value> = mod_social::accounts::networks(&s.env)
            .iter()
            .map(|n| {
                json!({ "network": n.network, "label": n.label, "supported": n.supported, "configured": n.configured })
            })
            .collect();
        wrapped(&json!({ "accounts": rows, "networks": networks, "manage_url": manage_url(ctx.base_url) }))
    })
}

fn list_social_media<'a>(
    _s: &'a SocialDeps,
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        ensure_enabled(ctx).await?;
        let kind = args.get("type").and_then(Value::as_str);
        let q = args.get("q").and_then(Value::as_str);
        let mut query = LibraryQuery::from_query(kind, q, None, None)
            .map_err(|e| ToolError::Internal(format!("{e:?}")))?;
        query.limit = u64::try_from(clamp_limit(args.get("limit"))).unwrap_or(20);
        query.cursor = opt_int(args.get("cursor"));
        let mut conn = ctx.deps.conn(ctx.principal.company).await?;
        let page = media::list(&mut conn, &query).await.map_err(app_err)?;
        let files: Vec<Value> = page.data.iter().map(|m| media_for_ai(m, ctx.base_url)).collect();
        wrapped(&json!({ "files": files, "next_cursor": page.next_cursor }))
    })
}

fn upload_social_media<'a>(
    s: &'a SocialDeps,
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        ensure_enabled(ctx).await?;
        let url = opt_str(args.get("url"), 2000).unwrap_or_default();
        let b64 = opt_str(args.get("data_base64"), 4_200_000).unwrap_or_default();
        let name = args.get("name").and_then(Value::as_str);
        if url.is_empty() == b64.is_empty() {
            return Err(ToolError::User(
                "Cần đúng một trong hai: url hoặc data_base64. / Provide exactly one of url or data_base64.".to_owned(),
            ));
        }
        let file_name = opt_str(args.get("file_name"), 200).unwrap_or_default();
        if url.is_empty() && file_name.is_empty() {
            return Err(ToolError::User(
                "Gửi data_base64 thì cần file_name có đuôi (vd banner.png). / file_name is required with data_base64.".to_owned(),
            ));
        }
        // `import_*` tự mượn kết nối ngắn: không giữ kết nối nào ở đây, và không gọi HTTP khi đang giữ kết nối.
        let c = MediaCtx {
            db: &ctx.deps.db,
            company: ctx.principal.company,
            store: &s.store,
            env: &s.env,
            user_id: ctx.principal.user_id,
            now_ms: chrono::Utc::now().timestamp_millis(),
        };
        let item = if url.is_empty() {
            media::import_base64(&c, &b64, &file_name, name).await
        } else {
            media::import_from_url(&c, &url, name).await
        }
        .map_err(|e| user_if(e, |st| st == 400))?;
        let mut out = media_for_ai(&item, ctx.base_url);
        out["next_step"] = json!(
            "Đưa media_key vào create_social_post.media_keys; người dùng vẫn phải đồng ý nội dung trước khi đăng."
        );
        wrapped(&out)
    })
}

fn enable_social_account<'a>(
    _s: &'a SocialDeps,
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        ensure_enabled(ctx).await?;
        let Some(id) = opt_int(args.get("account_id")) else {
            return Err(ToolError::User("account_id không hợp lệ. / Invalid account_id.".to_owned()));
        };
        let mut conn = ctx.deps.conn(ctx.principal.company).await?;
        let a = mod_social::accounts::enable(&mut conn, id)
            .await
            .map_err(|e| user_if(e, |st| st < 500))?;
        wrapped(&json!({
            "account_id": a.id,
            "network": a.network,
            "name": a.name,
            "status": a.status,
            "manage_url": manage_url(ctx.base_url),
        }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};

    #[test]
    fn gio_viet_nam_co_hau_to() {
        let t = Timestamp(Utc.with_ymd_and_hms(2026, 10, 12, 11, 26, 5).unwrap());
        assert_eq!(vn_iso(&t), "2026-10-12T18:26:05+07:00");
        let t = Timestamp(Utc.with_ymd_and_hms(2026, 10, 12, 20, 0, 0).unwrap());
        assert_eq!(vn_iso(&t), "2026-10-13T03:00:00+07:00");
    }

    #[test]
    fn tep_thu_vien_cho_ai() {
        let m = LibraryItem {
            id: 7,
            key: "social/u1_1_abc.png".into(),
            r#type: "image".into(),
            content_type: "image/png".into(),
            size: 1536,
            name: "banner.png".into(),
            source: "mcp".into(),
            uploaded_by: 1,
            created_at: Timestamp(Utc.with_ymd_and_hms(2026, 10, 12, 0, 0, 0).unwrap()),
        };
        let v = media_for_ai(&m, "https://x.test");
        assert_eq!(v["size_kb"], 2);
        assert_eq!(v["media_key"], "social/u1_1_abc.png");
        assert_eq!(v["uploaded_at"], "2026-10-12T07:00:00+07:00");
        assert_eq!(v["preview_url"], "https://x.test/social?tab=library&media=7");
    }
}
