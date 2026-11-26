//! Mẫu thông báo (5 endpoint `/api/v1/templates`) và render Handlebars. Bản TS: `templates/templates.service.ts`.
//! Mọi route đòi `settings.integrations` (không có quyền riêng cho mẫu thông báo). Chế độ kiểm đầu vào lenient (trường lạ
//! bị bỏ), theo `LENIENT_PREFIXES` của K15.
//!
//! Mẫu do quản trị công ty sửa nên là dữ liệu không tin cậy: chỉ cho helper `if`, `each`, `with`, `unless`, `lookup`, `log`
//! (như `knownHelpersOnly` của bản TS); engine Rust gỡ các helper thêm của nó (`eq`, `and`, `len`…) và [`check_syntax`] từ
//! chối mọi lời gọi helper khác ngay khi lưu (400), thay vì để lỗi nổ lúc render.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use handlebars::template::{Parameter, Subexpression, Template, TemplateElement};
use handlebars::{Context, Handlebars, Helper, HelperResult, Output, RenderContext};
use serde::Deserialize;
use serde_json::Value;
use sqlx::PgConnection;
use trinity_db::TenantDb;
use trinity_db::models::NotificationTemplate;
use trinity_db::pg_error::app_error;
use trinity_kernel::error::{AppError, HttpError};

use crate::notifications::Channel;

/// Helper được dùng trong mẫu.
const ALLOWED_HELPERS: [&str; 7] = ["if", "each", "with", "unless", "lookup", "log", "raw"];
/// Helper Handlebars-rust có thêm mà handlebars.js không có: gỡ khỏi engine.
const EXTRA_HELPERS: [&str; 11] = ["eq", "ne", "gt", "gte", "lt", "lte", "and", "or", "not", "len", "raw"];
/// Helper nội bộ in giá trị đúng chữ của JS: biểu thức `{{x}}` được viết lại thành `{{__js_esc x}}` (và `{{{x}}}` thành `__js_raw`).
const JS_ESC: &str = "__js_esc";
const JS_RAW: &str = "__js_raw";

/// `String(value)` của JS: `null`/thiếu = rỗng, mảng nối bằng `,`, đối tượng `[object Object]`, số theo `Number#toString`.
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => trinity_kernel::json::js_number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// `Handlebars.escapeExpression`: `& < > " ' ` =`.
fn js_escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&#x27;"),
            '`' => o.push_str("&#x60;"),
            '=' => o.push_str("&#x3D;"),
            c => o.push(c),
        }
    }
    o
}

fn js_helper(h: &Helper<'_>, out: &mut dyn Output, escape: bool) -> HelperResult {
    let text = h.param(0).map(|p| js_string(p.value())).unwrap_or_default();
    out.write(&if escape { js_escape(&text) } else { text })?;
    Ok(())
}

fn new_engine() -> Handlebars<'static> {
    let mut hb = Handlebars::new();
    for h in EXTRA_HELPERS {
        hb.unregister_helper(h);
    }
    hb.register_helper(
        JS_ESC,
        Box::new(
            |h: &Helper<'_>, _: &Handlebars<'_>, _: &Context, _: &mut RenderContext<'_, '_>, out: &mut dyn Output| {
                js_helper(h, out, true)
            },
        ),
    );
    hb.register_helper(
        JS_RAW,
        Box::new(
            |h: &Helper<'_>, _: &Handlebars<'_>, _: &Context, _: &mut RenderContext<'_, '_>, out: &mut dyn Output| {
                js_helper(h, out, false)
            },
        ),
    );
    hb
}

/// Bọc mọi biểu thức in giá trị (`{{x}}`, `{{lookup a b}}`) bằng helper in kiểu JS; engine Rust in mảng/đối tượng/số
/// khác handlebars.js (`[a, b]`, `[object]`).
fn rewrite(elements: &mut [TemplateElement]) {
    for el in elements {
        match el {
            TemplateElement::Expression(h) => wrap(h, JS_ESC),
            TemplateElement::HtmlExpression(h) => wrap(h, JS_RAW),
            // `{{{{raw}}}}…{{{{/raw}}}}`: handlebars.js không có helper `raw` (knownHelpersOnly vẫn cho lưu) nên in rỗng.
            TemplateElement::HelperBlock(h) if matches!(&h.name, Parameter::Name(n) if n == "raw") => {
                *el = TemplateElement::RawString(String::new());
            }
            TemplateElement::HelperBlock(h) => {
                for sub in [h.template.as_mut(), h.inverse.as_mut()].into_iter().flatten() {
                    rewrite(&mut sub.elements);
                }
            }
            _ => {}
        }
    }
}

fn wrap(h: &mut handlebars::template::HelperTemplate, helper: &str) {
    if h.block || !h.hash.is_empty() {
        return;
    }
    let is_lookup = matches!(&h.name, Parameter::Name(n) if n == "lookup");
    let is_path = matches!(&h.name, Parameter::Path(_)) && h.params.is_empty();
    if is_path {
        let inner = std::mem::replace(&mut h.name, Parameter::Name(helper.to_owned()));
        h.params.push(inner);
    } else if is_lookup {
        let name = std::mem::replace(&mut h.name, Parameter::Name(helper.to_owned()));
        let params = std::mem::take(&mut h.params);
        h.params.push(Parameter::Subexpression(Subexpression::new(
            name,
            params,
            std::collections::HashMap::new(),
        )));
    }
}

/// Mẫu sau khi render.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    pub subject: Option<String>,
    pub body: String,
}

/// Quy tắc người nhận (lưu cùng mẫu, chưa dùng để chọn người nhận).
pub type RecipientsRule = Value;

/// Body `POST /templates` (K15 lenient: `name`, `event_type`, `body` chuỗi không rỗng; `channel` thuộc `push|in_app|webhook`).
#[derive(Debug, Clone, Deserialize)]
pub struct CreateTemplate {
    pub name: String,
    pub event_type: String,
    pub channel: Channel,
    #[serde(default)]
    pub subject: Option<String>,
    pub body: String,
    #[serde(default)]
    pub recipients_rule: Option<RecipientsRule>,
    #[serde(default)]
    pub is_active: Option<bool>,
}

/// Body `PATCH /templates/:id`. `subject` và `recipients_rule` nhận `null` (xoá); các trường còn lại là cột NOT NULL.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateTemplate {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub event_type: Option<String>,
    #[serde(default)]
    pub channel: Option<Channel>,
    #[serde(default, deserialize_with = "nullable")]
    pub subject: Option<Option<String>>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    pub recipients_rule: Option<Option<RecipientsRule>>,
    #[serde(default)]
    pub is_active: Option<bool>,
}

fn nullable<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

fn walk(elements: &[TemplateElement], out: &mut Result<(), String>) {
    for el in elements {
        let helper = match el {
            TemplateElement::HtmlExpression(h) | TemplateElement::Expression(h) | TemplateElement::HelperBlock(h) => h,
            _ => continue,
        };
        // `{{ten}}` một mình là tra cứu biến (Path); chỉ lời gọi helper có tên (Name) mới bị kiểm.
        if let Parameter::Name(n) = &helper.name
            && !ALLOWED_HELPERS.contains(&n.as_str())
        {
            *out = Err(format!(
                "You specified knownHelpersOnly, but used the unknown helper {n}"
            ));
            return;
        }
        for p in helper.params.iter().chain(helper.hash.values()) {
            if let Parameter::Subexpression(s) = p {
                walk(std::slice::from_ref(&*s.element), out);
            }
        }
        for sub in [&helper.template, &helper.inverse].into_iter().flatten() {
            walk(&sub.elements, out);
        }
    }
}

/// Parse ngay khi lưu: cú pháp sai hoặc helper lạ ⇒ 400 `Cú pháp template không hợp lệ: <dòng đầu của lỗi>`.
pub fn check_syntax(sources: &[Option<&str>]) -> Result<(), HttpError> {
    for src in sources.iter().flatten().filter(|s| !s.is_empty()) {
        let bad = |m: String| {
            HttpError::bad_request(format!(
                "Cú pháp template không hợp lệ: {}",
                m.lines().next().unwrap_or("")
            ))
        };
        let t = Template::compile(src).map_err(|e| bad(e.to_string()))?;
        let mut res = Ok(());
        walk(&t.elements, &mut res);
        res.map_err(bad)?;
    }
    Ok(())
}

/// Render một nguồn mẫu với `data`.
pub fn render_source(src: &str, data: &Value) -> Result<String, AppError> {
    let mut tpl = Template::compile(src).map_err(AppError::internal)?;
    rewrite(&mut tpl.elements);
    let mut hb = new_engine();
    hb.register_template("t", tpl);
    hb.render("t", data).map_err(AppError::internal)
}

fn render_template(t: &NotificationTemplate, data: &Value) -> Result<Rendered, AppError> {
    let body = render_source(&t.body, data)?;
    let subject = match t.subject.as_deref().filter(|s| !s.is_empty()) {
        Some(s) => Some(render_source(s, data)?),
        None => None,
    };
    Ok(Rendered { subject, body })
}

/// `GET /templates`: mới nhất trước.
pub async fn find_all(conn: &mut PgConnection) -> Result<Vec<NotificationTemplate>, AppError> {
    sqlx::query_as::<_, NotificationTemplate>(
        "SELECT id, name, event_type, channel, subject, body, recipients_rule, is_active, created_at, updated_at \
         FROM notification_templates ORDER BY created_at DESC",
    )
    .fetch_all(conn)
    .await
    .map_err(db)
}

/// `GET /templates/:id`: 404 `Template #<id> khong ton tai`.
pub async fn find_by_id(conn: &mut PgConnection, id: i32) -> Result<NotificationTemplate, AppError> {
    sqlx::query_as::<_, NotificationTemplate>(
        "SELECT id, name, event_type, channel, subject, body, recipients_rule, is_active, created_at, updated_at \
         FROM notification_templates WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(db)?
    .ok_or_else(|| HttpError::not_found(format!("Template #{id} khong ton tai")).into())
}

fn rule_text(r: &Option<RecipientsRule>) -> Option<String> {
    r.as_ref().map(trinity_kernel::json::js_json)
}

/// `POST /templates`.
pub async fn create(conn: &mut PgConnection, input: &CreateTemplate) -> Result<NotificationTemplate, AppError> {
    check_syntax(&[input.subject.as_deref(), Some(&input.body)])?;
    sqlx::query_as::<_, NotificationTemplate>(
        "INSERT INTO notification_templates (name, event_type, channel, subject, body, recipients_rule, is_active, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6::text::jsonb, $7, now()) \
         RETURNING id, name, event_type, channel, subject, body, recipients_rule, is_active, created_at, updated_at",
    )
    .bind(&input.name)
    .bind(&input.event_type)
    .bind(input.channel.as_str())
    .bind(&input.subject)
    .bind(&input.body)
    .bind(rule_text(&input.recipients_rule))
    .bind(input.is_active.unwrap_or(true))
    .fetch_one(conn)
    .await
    .map_err(db)
}

/// `PATCH /templates/:id`: 404 nếu không có; kiểm cú pháp `subject`/`body` mới.
pub async fn update(
    conn: &mut PgConnection,
    id: i32,
    input: &UpdateTemplate,
) -> Result<NotificationTemplate, AppError> {
    find_by_id(&mut *conn, id).await?;
    check_syntax(&[input.subject.as_ref().and_then(|s| s.as_deref()), input.body.as_deref()])?;
    let (set_subject, subject) = match &input.subject {
        Some(s) => (true, s.as_deref()),
        None => (false, None),
    };
    let (set_rule, rule) = match &input.recipients_rule {
        Some(r) => (true, rule_text(r)),
        None => (false, None),
    };
    sqlx::query_as::<_, NotificationTemplate>(
        "UPDATE notification_templates SET name = COALESCE($2, name), event_type = COALESCE($3, event_type), \
         channel = COALESCE($4, channel), subject = CASE WHEN $5 THEN $6 ELSE subject END, body = COALESCE($7, body), \
         recipients_rule = CASE WHEN $8 THEN $9::text::jsonb ELSE recipients_rule END, \
         is_active = COALESCE($10, is_active), updated_at = now() WHERE id = $1 \
         RETURNING id, name, event_type, channel, subject, body, recipients_rule, is_active, created_at, updated_at",
    )
    .bind(id)
    .bind(input.name.as_deref())
    .bind(input.event_type.as_deref())
    .bind(input.channel.map(Channel::as_str))
    .bind(set_subject)
    .bind(subject)
    .bind(input.body.as_deref())
    .bind(set_rule)
    .bind(rule)
    .bind(input.is_active)
    .fetch_optional(conn)
    .await
    .map_err(db)?
    .ok_or_else(|| HttpError::not_found(format!("Template #{id} khong ton tai")).into())
}

/// `DELETE /templates/:id` (204): xoá cứng.
pub async fn remove(conn: &mut PgConnection, id: i32) -> Result<(), AppError> {
    find_by_id(&mut *conn, id).await?;
    sqlx::query("DELETE FROM notification_templates WHERE id = $1")
        .bind(id)
        .execute(conn)
        .await
        .map_err(db)?;
    Ok(())
}

/// Render mẫu theo id.
pub async fn render(db_: &TenantDb, template_id: i32, data: &Value) -> Result<Rendered, AppError> {
    let mut conn = db_.acquire().await.map_err(AppError::internal)?;
    let t = find_by_id(&mut conn, template_id).await?;
    render_template(&t, data)
}

/// Render mẫu đang bật đầu tiên của `(event_type, channel)`; không có ⇒ `None`.
pub async fn render_by_event_type(
    db_: &TenantDb,
    event_type: &str,
    channel: Channel,
    data: &Value,
) -> Result<Option<Rendered>, AppError> {
    let mut conn = db_.acquire().await.map_err(AppError::internal)?;
    let t = sqlx::query_as::<_, NotificationTemplate>(
        "SELECT id, name, event_type, channel, subject, body, recipients_rule, is_active, created_at, updated_at \
         FROM notification_templates WHERE event_type = $1 AND channel = $2 AND is_active LIMIT 1",
    )
    .bind(event_type)
    .bind(channel.as_str())
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    drop(conn);
    t.map(|t| render_template(&t, data)).transpose()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn render_nhu_handlebars_js() {
        let d = json!({"contactName": "Nguyễn <A>", "n": 3, "list": ["a", "b"], "flag": false, "nothing": null});
        let r = |s: &str| render_source(s, &d).unwrap();
        // Thoát HTML như handlebars.js: & < > " ' ` =
        assert_eq!(
            r("Deal {{contactName}} {{{contactName}}}"),
            "Deal Nguyễn &lt;A&gt; Nguyễn <A>"
        );
        assert_eq!(r("{{n}} {{missing}} {{nothing}} {{flag}}"), "3   false");
        assert_eq!(r("{{#each list}}[{{this}}]{{/each}}"), "[a][b]");
        assert_eq!(r("{{#if flag}}Y{{else}}N{{/if}}{{#unless flag}}U{{/unless}}"), "NU");
        assert_eq!(r("{{#with contactName}}{{this}}{{/with}}"), "Nguyễn &lt;A&gt;");
        assert_eq!(
            r("a&b \"q\" 'x' `y` =z {{contactName}}"),
            "a&b \"q\" 'x' `y` =z Nguyễn &lt;A&gt;"
        );
        assert_eq!(r("{{lookup list 1}}"), "b");
    }

    #[test]
    fn chi_cho_helper_co_san() {
        assert!(
            check_syntax(&[
                Some("{{#if a}}{{#each b}}{{this}}{{/each}}{{/if}} {{lookup x 0}}"),
                None
            ])
            .is_ok()
        );
        for bad in [
            "{{eq a b}}",
            "{{#len x}}y{{/len}}",
            "{{foo bar}}",
            "{{lookup (and a b) 0}}",
            "{{#if a}}{{upper b}}{{/if}}",
        ] {
            let e = check_syntax(&[Some(bad)]).unwrap_err();
            let body = e.body();
            let m = match body.message {
                trinity_kernel::error::Message::One(m) => m,
                other => panic!("{other:?}"),
            };
            assert!(m.starts_with("Cú pháp template không hợp lệ: "), "{bad}: {m}");
        }
        // Cú pháp hỏng.
        assert!(check_syntax(&[Some("{{#if a}}thiếu đóng")]).is_err());
        assert!(check_syntax(&[Some("{{unclosed")]).is_err());
        // Biến đơn là tra cứu, không phải helper.
        assert!(check_syntax(&[Some("{{eq}}"), Some("")]).is_ok());
    }

    #[test]
    fn helper_goi_them_khong_chay_duoc_luc_render() {
        assert!(render_source("{{eq 1 1}}", &json!({})).is_err());
    }
}
