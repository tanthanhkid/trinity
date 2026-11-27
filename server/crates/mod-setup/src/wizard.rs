//! Wizard bắt đầu (`onboarding-wizard.service.ts`): người dùng đi hết các bước (máy chủ KIỂM THẬT từng bước) mới vào được ứng dụng:
//! chọn loại doanh nghiệp → chọn phân hệ rồi "Dựng hệ thống" (không cần AI) → dữ liệu đầu tiên → (tuỳ chọn) kênh, đăng bài. Các bước
//! tính theo công ty; người có tài khoản tạo SAU lúc công ty đã dựng vào thẳng ứng dụng. Xong một lần thì ghi
//! `onboarding_done:user:<id>` và không bao giờ khoá lại.

use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_kernel::error::HttpError;
use trinity_rbac::{Grants, can};

use crate::build::{SETUP_BUILT_KEY, SETUP_INDUSTRY_KEY, is_built};
use crate::{Actor, Ctx, R, bad, db, js_parse_date, now_iso, read_setting, samples, write_setting};

pub const STEPS: [&str; 5] = ["industry", "modules", "data", "channels", "post"];
/// 1 dòng `settings.onboarding_wizard` (JSON).
pub const CONFIG_KEY: &str = "onboarding_wizard";
pub const CONFIG_VERSION: i64 = 2;
const DEFAULT_SKIPPABLE: [&str; 3] = ["data", "channels", "post"];

pub fn done_key(user_id: i32) -> String {
    format!("onboarding_done:user:{user_id}")
}

pub fn skip_key(user_id: i32) -> String {
    format!("onboarding_skip:user:{user_id}")
}

fn step_of(s: &str) -> Option<&'static str> {
    STEPS.iter().copied().find(|k| *k == s)
}

/// Quyền cần để TỰ làm bước (thiếu thì bước vẫn bắt buộc, màn hình nhờ quản trị viên làm).
fn step_permissions(step: &str) -> &'static [&'static str] {
    match step {
        "industry" | "modules" => &["custom_objects.manage", "settings.features"],
        "channels" => &["social.manage"],
        "post" => &["social.post"],
        _ => &[],
    }
}

/// Chưa đạt thì nói rõ thiếu gì và làm sao — lời cho người dùng thường, không thuật ngữ.
fn missing(step: &str) -> &'static str {
    match step {
        "industry" => {
            "Bạn chưa chọn loại doanh nghiệp. Chọn một loại, chọn các phân hệ muốn dùng rồi bấm \"Dựng hệ thống\"."
        }
        "modules" => "Hệ thống chưa được dựng. Chọn các phân hệ muốn dùng rồi bấm \"Dựng hệ thống\".",
        "data" => {
            "Trinity chưa có khách hàng hay bản ghi thật nào (bản ghi mẫu không tính). Thêm một khách đầu tiên hoặc nhập file, xong thì bấm lại nút này."
        }
        "channels" => {
            "Chưa có kênh nào đang hoạt động. Bấm \"Liên kết\" ở Facebook, đồng ý trên trang của Facebook, chờ kênh hiện \"Hoạt động\" rồi bấm lại nút này."
        }
        _ => {
            "Chưa có bài nào đăng thành công. Soạn một bài, chọn kênh, bấm \"Đăng ngay\", chờ bài báo đã đăng rồi bấm lại nút này."
        }
    }
}

/// Người thiếu quyền không tự làm được: không chỉ họ cách làm (chọn/bấm Dựng), chỉ nhờ quản trị viên.
const ASK_ADMIN: &str = "Quản trị viên của công ty chưa làm xong việc này. Bạn nhờ họ làm, rồi bấm lại nút này.";

/// Cấu hình: vắng = bật; "Dữ liệu đầu tiên", "Kênh" và "Đăng bài" được bỏ qua; không miễn ai.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// `false` = tắt hẳn wizard (ai cũng vào thẳng ứng dụng).
    pub enabled: bool,
    pub skippable: Vec<&'static str>,
    /// Miễn wizard cho tài khoản tạo TRƯỚC thời điểm này (ISO).
    pub exempt_before: Option<String>,
    pub version: i64,
}

impl Config {
    fn default_config() -> Self {
        Self {
            enabled: true,
            skippable: DEFAULT_SKIPPABLE.to_vec(),
            exempt_before: None,
            version: CONFIG_VERSION,
        }
    }

    pub fn to_json(&self) -> Value {
        json!({ "enabled": self.enabled, "skippable": self.skippable, "exempt_before": self.exempt_before, "version": self.version })
    }
}

/// Config CHƯA có version (cũ) mà đúng ['post'] (mặc định cũ) thì nâng lên mặc định mới; config có version thì tôn trọng nguyên lựa chọn.
fn upgrade_skippable(list: Vec<&'static str>, version: Option<&Value>) -> Vec<&'static str> {
    let legacy = version
        .and_then(Value::as_f64)
        .is_none_or(|v| v < CONFIG_VERSION as f64);
    if legacy && list == ["post"] {
        DEFAULT_SKIPPABLE.to_vec()
    } else {
        list
    }
}

pub fn parse_config(raw: Option<&str>) -> Config {
    let Some(v) = raw
        .filter(|s| !s.is_empty())
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .filter(|v| !v.is_null())
    else {
        return Config::default_config();
    };
    Config {
        enabled: v.get("enabled") != Some(&Value::Bool(false)),
        skippable: match v.get("skippable").and_then(Value::as_array) {
            Some(a) => upgrade_skippable(
                a.iter().filter_map(|x| x.as_str().and_then(step_of)).collect(),
                v.get("version"),
            ),
            None => DEFAULT_SKIPPABLE.to_vec(),
        },
        exempt_before: v
            .get("exempt_before")
            .and_then(Value::as_str)
            .filter(|s| js_parse_date(s).is_some())
            .map(str::to_owned),
        version: CONFIG_VERSION,
    }
}

pub async fn config(ctx: &Ctx, actor: &Actor) -> R<Value> {
    let mut c = ctx.conn(actor.company).await?;
    Ok(read_config(&mut c).await?.to_json())
}

async fn read_config(c: &mut PgConnection) -> R<Config> {
    Ok(parse_config(read_setting(c, CONFIG_KEY).await?.as_deref()))
}

/// `PUT /setup/wizard/config`: khoá nào gửi lên thì đè khoá hiện có, khoá vắng giữ nguyên; `exempt_before: null` bỏ miễn.
pub async fn set_config(ctx: &Ctx, actor: &Actor, patch: &Value) -> R<Value> {
    let mut c = ctx.conn(actor.company).await?;
    let cur = read_config(&mut c).await?;
    let mut merged = cur.to_json().as_object().cloned().unwrap_or_default();
    for k in ["enabled", "skippable", "exempt_before"] {
        if let Some(v) = patch.get(k) {
            merged.insert(k.to_owned(), v.clone());
        }
    }
    let next = parse_config(Some(&Value::Object(merged).to_string()));
    write_setting(&mut c, CONFIG_KEY, &next.to_json().to_string(), Some(actor.user_id)).await?;
    Ok(next.to_json())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepView {
    pub key: &'static str,
    pub done: bool,
    pub skipped: bool,
    pub can_skip: bool,
    /// Người đang xem thiếu quyền tự làm bước này.
    pub needs_admin: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct View {
    pub enabled: bool,
    pub completed: bool,
    /// Loại doanh nghiệp đã chọn khi dựng (`None` = chưa dựng).
    pub industry: Option<String>,
    /// Hiện còn bản ghi mẫu (giả) chưa bị dọn.
    pub sample_data: bool,
    pub current: Option<&'static str>,
    pub steps: Vec<StepView>,
}

impl View {
    pub fn to_json(&self) -> Value {
        json!({
            "enabled": self.enabled, "completed": self.completed, "industry": self.industry, "sample_data": self.sample_data,
            "current": self.current,
            "steps": self.steps.iter().map(|s| json!({
                "key": s.key, "done": s.done, "skipped": s.skipped, "can_skip": s.can_skip, "needs_admin": s.needs_admin,
            })).collect::<Vec<_>>(),
        })
    }
}

async fn exists(c: &mut PgConnection, sql: &str) -> R<bool> {
    let r: Option<i32> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_owned()))
        .fetch_optional(&mut *c)
        .await
        .map_err(db)?;
    Ok(r.is_some())
}

/// Bước nào áp dụng cho công ty này: tắt tính năng / máy chủ chưa cấu hình mạng nào thì không bắt làm bước không làm nổi.
async fn applicable(ctx: &Ctx, c: &mut PgConnection, actor: &Actor) -> R<Vec<&'static str>> {
    let f = mod_settings::features::get(
        c,
        mod_settings::Ctx {
            company_id: Some(actor.company.id()),
        },
    )
    .await?;
    let on = |k: &str| f.0.iter().find(|(key, _)| *key == k).and_then(|(_, v)| *v) != Some(false);
    let env = |k: &str| ctx.env(k).map(|v| v.trim().to_owned()).unwrap_or_default();
    // Mạng Facebook "đã cấu hình": có app id/secret và URL gốc công khai (chỉ còn một mạng đăng bài).
    let fb_ready = !env("FACEBOOK_APP_ID").is_empty()
        && !env("FACEBOOK_APP_SECRET").is_empty()
        && trinity_integrations::status::public_base_url(&|k: &str| ctx.env(k)).is_some();
    let social = on("social_posting") && fb_ready;
    let page = on("facebook_page") && fb_ready;
    Ok(STEPS
        .iter()
        .copied()
        .filter(|k| match *k {
            "channels" => social || page,
            "post" => social,
            _ => true,
        })
        .collect())
}

#[derive(Clone, Copy)]
struct Checks {
    industry: bool,
    modules: bool,
    data: bool,
    channels: bool,
    post: bool,
}

impl Checks {
    fn of(&self, step: &str) -> bool {
        match step {
            "industry" => self.industry,
            "modules" => self.modules,
            "data" => self.data,
            "channels" => self.channels,
            _ => self.post,
        }
    }
}

/// Kiểm THẬT từng bước theo dữ liệu. Dữ liệu: bản ghi MẪU không tính (chỉ bản ghi thật mới qua bước).
async fn checks(c: &mut PgConnection) -> R<Checks> {
    let sample = samples::read(c).await?;
    let industry = read_setting(c, SETUP_INDUSTRY_KEY).await?.is_some();
    let built = is_built(c).await?;
    let account = exists(c, "SELECT id FROM social_accounts WHERE status = 'active' LIMIT 1").await?;
    let page = exists(c, "SELECT id FROM facebook_pages WHERE is_active LIMIT 1").await?;
    let post = exists(
        c,
        "SELECT id FROM social_post_targets WHERE status = 'published' LIMIT 1",
    )
    .await?;
    let data = samples::has_real(c, sample.as_ref()).await?;
    // Bản cài cũ đã có bảng tuỳ biến (AI dựng) coi như đã chọn ngành + dựng.
    Ok(Checks {
        industry: industry || built,
        modules: built,
        data,
        channels: account || page,
        post,
    })
}

async fn created_at(c: &mut PgConnection, user_id: i32) -> R<Option<DateTime<Utc>>> {
    sqlx::query_scalar("SELECT created_at FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&mut *c)
        .await
        .map_err(db)
}

/// Người có tài khoản tạo SAU lúc công ty dựng xong vào thẳng ứng dụng, không phải đi lại wizard.
async fn joined_after_build(c: &mut PgConnection, user_id: i32) -> R<bool> {
    let Some(raw) = read_setting(c, SETUP_BUILT_KEY).await? else {
        // Hệ thống đã dựng từ lâu (luồng AI cũ, không có setup_built): người dùng cũ và người mới đều vào thẳng ứng dụng.
        return is_built(c).await;
    };
    let at = serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|j| j.get("built_at").and_then(Value::as_str).and_then(js_parse_date));
    let Some(at) = at else { return Ok(false) };
    Ok(created_at(c, user_id).await?.is_some_and(|u| u > at))
}

async fn skipped(c: &mut PgConnection, user_id: i32) -> R<Vec<&'static str>> {
    let raw = read_setting(c, &skip_key(user_id)).await?;
    let v: Option<Value> = raw.as_deref().and_then(|s| serde_json::from_str(s).ok());
    Ok(v.as_ref()
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().and_then(step_of)).collect())
        .unwrap_or_default())
}

async fn is_exempt(c: &mut PgConnection, user_id: i32, cfg: &Config) -> R<bool> {
    let Some(before) = cfg.exempt_before.as_deref().and_then(js_parse_date) else {
        return Ok(false);
    };
    Ok(created_at(c, user_id).await?.is_some_and(|u| u < before))
}

fn lacks(grants: &Grants, perms: &[&str]) -> bool {
    perms.iter().any(|p| !can(grants, p, None))
}

pub async fn view(ctx: &Ctx, actor: &Actor) -> R<View> {
    let cfg = {
        let mut c = ctx.conn(actor.company).await?;
        read_config(&mut c).await?
    };
    if !cfg.enabled {
        return Ok(View {
            enabled: false,
            completed: true,
            industry: None,
            sample_data: false,
            current: None,
            steps: Vec::new(),
        });
    }
    // Lưới an toàn: khách/bản ghi thật vào bằng đường không đi qua chỗ tạo (nhập file, webhook, kênh chat…) cũng dọn mẫu.
    samples::purge_if_real(ctx, actor.company).await;
    let mut c = ctx.conn(actor.company).await?;
    let done_flag = read_setting(&mut c, &done_key(actor.user_id)).await?;
    let exempt = is_exempt(&mut c, actor.user_id, &cfg).await?;
    let later = joined_after_build(&mut c, actor.user_id).await?;
    let steps = applicable(ctx, &mut c, actor).await?;
    let ck = checks(&mut c).await?;
    let skip = skipped(&mut c, actor.user_id).await?;
    let industry = read_setting(&mut c, SETUP_INDUSTRY_KEY).await?;
    let sample_left = samples::remaining(&mut c).await.is_some();
    let list: Vec<StepView> = steps
        .into_iter()
        .map(|key| StepView {
            key,
            done: ck.of(key),
            skipped: !ck.of(key) && skip.contains(&key) && cfg.skippable.contains(&key),
            can_skip: cfg.skippable.contains(&key),
            needs_admin: lacks(&actor.grants, step_permissions(key)),
        })
        .collect();
    let current = list.iter().find(|s| !s.done && !s.skipped).map(|s| s.key);
    // Người được cho qua vì vào sau lúc dựng: ghi dấu xong để dựng lại sau này không đẩy họ lại wizard. Ghi phụ: lỗi không làm hỏng việc xem.
    if later
        && done_flag.is_none()
        && let Err(e) = write_setting(&mut c, &done_key(actor.user_id), &now_iso(), Some(actor.user_id)).await
    {
        tracing::warn!("không ghi được dấu xong wizard: {e}");
    }
    Ok(View {
        enabled: true,
        completed: done_flag.is_some() || exempt || later,
        industry,
        sample_data: sample_left,
        current,
        steps: list,
    })
}

/// `POST /setup/wizard/confirm`: kiểm lại bước; đạt và mọi bước đã qua ⇒ ghi xong wizard.
pub async fn confirm(ctx: &Ctx, actor: &Actor, step: &str) -> R<Value> {
    confirm_inner(ctx, actor, step, false).await
}

async fn confirm_inner(ctx: &Ctx, actor: &Actor, step: &str, _skipped: bool) -> R<Value> {
    let mut wizard = view(ctx, actor).await?;
    let Some(s) = wizard.steps.iter().find(|x| x.key == step).cloned() else {
        return Err(bad("Bước này không có trong phần bắt đầu của công ty bạn."));
    };
    if !s.done && !s.skipped {
        let msg = if s.needs_admin { ASK_ADMIN } else { missing(step) };
        return Ok(json!({ "ok": false, "message": msg, "wizard": wizard.to_json() }));
    }
    // TODO(serve): sự kiện sản phẩm `onboarding_step` { step, action: skip | confirm } (chưa có cổng đo ở Rust).
    if !wizard.completed && wizard.current.is_none() {
        let mut c = ctx.conn(actor.company).await?;
        write_setting(&mut c, &done_key(actor.user_id), &now_iso(), Some(actor.user_id)).await?;
        tracing::info!("user {} xong wizard bắt đầu", actor.user_id);
        wizard.completed = true;
    }
    Ok(json!({ "ok": true, "message": Value::Null, "wizard": wizard.to_json() }))
}

/// `POST /setup/wizard/skip`: chỉ được khi cấu hình cho phép bỏ qua bước đó.
pub async fn skip(ctx: &Ctx, actor: &Actor, step: &str) -> R<Value> {
    {
        let mut c = ctx.conn(actor.company).await?;
        let cfg = read_config(&mut c).await?;
        if !cfg.skippable.contains(&step) {
            return Err(HttpError::bad_request("Bước này bắt buộc, không bỏ qua được.").into());
        }
        let mut cur = skipped(&mut c, actor.user_id).await?;
        if !cur.contains(&step) {
            cur.push(step_of(step).unwrap_or("post"));
            write_setting(
                &mut c,
                &skip_key(actor.user_id),
                &json!(cur).to_string(),
                Some(actor.user_id),
            )
            .await?;
        }
    }
    confirm_inner(ctx, actor, step, true).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cau_hinh_cu_va_moi() {
        let d = parse_config(None);
        assert_eq!(
            (d.enabled, d.skippable.clone(), d.exempt_before.clone(), d.version),
            (true, vec!["data", "channels", "post"], None, 2)
        );
        // Config CŨ (không version) đúng ["post"] được nâng; có version thì giữ nguyên lựa chọn của admin.
        assert_eq!(
            parse_config(Some(r#"{"skippable":["post"]}"#)).skippable,
            ["data", "channels", "post"]
        );
        assert_eq!(
            parse_config(Some(r#"{"skippable":["post"],"version":2}"#)).skippable,
            ["post"]
        );
        // Bước lạ bị bỏ; rác ⇒ mặc định; enabled chỉ tắt khi đúng false.
        assert_eq!(
            parse_config(Some(r#"{"skippable":["post","khac",1],"version":2}"#)).skippable,
            ["post"]
        );
        assert_eq!(parse_config(Some("{rac")), Config::default_config());
        assert_eq!(parse_config(Some("null")), Config::default_config());
        assert!(!parse_config(Some(r#"{"enabled":false}"#)).enabled);
        assert!(parse_config(Some(r#"{"enabled":"x"}"#)).enabled);
        assert_eq!(
            parse_config(Some(r#"{"exempt_before":"2026-11-01T00:00:00Z"}"#))
                .exempt_before
                .as_deref(),
            Some("2026-11-01T00:00:00Z")
        );
        assert_eq!(parse_config(Some(r#"{"exempt_before":"hôm qua"}"#)).exempt_before, None);
    }
}
