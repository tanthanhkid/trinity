//! Khung thao tác ghi của AI (M42), chuyển từ `services/crm/src/integrations/mcp/{tools/action-tools.ts,
//! actions/{action-types,action-helpers,action-registry,ai-actions.service}.ts}`.
//!
//! Mỗi thao tác ghi là một [`ActionDef`] (`prepare` kiểm quyền/phạm vi/dữ liệu và KHÔNG ghi; `execute` chạy qua đúng module nghiệp vụ).
//! Mặc định tool ghi CHẠY NGAY với quyền người dùng đã kết nối ([`execute_now`]: ghi một dòng `ai_action_drafts` trạng thái
//! `approved` rồi `executed`/`failed` để có lịch sử "Hoạt động AI"); khi cài đặt `ai_require_approval = true` (hoặc đọc cài đặt lỗi)
//! thì chỉ tạo đề xuất chờ duyệt ([`create_draft`]), người dùng duyệt trên web (`mod-ai-actions`, qua [`run_approved`]).
//!
//! Không có thao tác xoá: danh sách [`all`] là nguồn duy nhất (test liệt kê tên). Ghi phụ (thông báo, nhật ký) lỗi chỉ ghi log;
//! không giữ hai kết nối của pool cùng lúc.

use std::sync::LazyLock;

use chrono::{DateTime, Duration, Utc};
use regex::{Captures, Regex};
use serde_json::{Map, Value, json};
use trinity_db::outbox::{NewNotification, create_notification};
use trinity_http::validate::{Mode, validate_value};
use trinity_integrations::audit::{self, AuditEntry, AuditStatus, Channel};
use trinity_kernel::error::{AppError, HttpError, Message};
use trinity_kernel::json::js_json;
use trinity_kernel::vi::trim_js;
use trinity_kernel::vn_time::js_iso_string;
use trinity_rbac::OwnerIds;
use unicode_normalization::UnicodeNormalization;

use crate::ai_output::{mask_phones_in_text, slice16};
use crate::args::opt_int;
use crate::auth::Principal;
use crate::deps::{ToolDeps, app_err};
use crate::exec::{ToolCtx, ToolError, ToolOutput, ToolRunner};
use crate::limits::{DRAFTS_PER_MINUTE, WRITES_PER_CLIENT_PER_MINUTE, WRITES_PER_MINUTE};
use crate::protocol::BoxFuture;
use crate::tools::wrapped;

/// Khoá `settings`: `true` ⇒ AI chỉ tạo đề xuất chờ duyệt; vắng hoặc khác ⇒ ghi thẳng.
pub const REQUIRE_APPROVAL_KEY: &str = "ai_require_approval";
pub const NOTE_MAX: usize = 2000;
const NOT_FOUND_MSG: &str = "Không tìm thấy bản ghi hoặc nằm ngoài phạm vi quyền của bạn";
/// Mỗi người tối đa ngần này đề xuất chờ; mỗi ỨNG DỤNG AI tối đa `MAX_PENDING_PER_CLIENT`.
const MAX_PENDING_DRAFTS: i64 = 50;
const MAX_PENDING_PER_CLIENT: i64 = 20;
/// Khoá advisory tuần tự hoá đếm + chèn đề xuất theo người dùng.
const ADVISORY_NS: i32 = 347;
/// Quá ngần này mà vẫn `approved` và chưa có `result` ⇒ tiến trình chết giữa chừng.
const EXECUTION_STALE_MINUTES: i64 = 5;

/// Dữ liệu một thao tác cần: người gọi (đã giới hạn cho AI khi tool chạy; người duyệt thật khi duyệt) và phụ thuộc.
pub struct ActionCx<'a> {
    pub principal: &'a Principal,
    pub deps: &'a ToolDeps,
}

/// Kết quả `prepare`: tham số đã chuẩn hoá (có thể chứa SĐT đầy đủ, KHÔNG BAO GIỜ trả ra API), tóm tắt và dòng chi tiết.
pub struct Prepared {
    pub params: Value,
    pub summary: String,
    pub details: Vec<Value>,
    /// Đổi cấu trúc: ảnh hưởng tới dữ liệu đang có (`{affected_records, confirm_label, lines, tables}`); có `confirm_label` thì người
    /// duyệt phải gõ đúng tên bảng. `None` cho thao tác không đổi cấu trúc.
    pub impact: Option<Value>,
}

pub type PrepareFn = for<'a> fn(&'a Value, &'a ActionCx<'a>) -> BoxFuture<'a, Result<Prepared, ToolError>>;
pub type ExecuteFn = for<'a> fn(&'a Value, &'a ActionCx<'a>, i32) -> BoxFuture<'a, Result<Value, ToolError>>;

pub struct ActionDef {
    pub name: &'static str,
    /// Nhãn tiếng Việt ở màn duyệt.
    pub label: &'static str,
    /// Cần ĐỦ MỌI quyền này, kiểm lúc gọi tool VÀ lúc duyệt.
    pub permissions: &'static [&'static str],
    pub prepare: PrepareFn,
    pub execute: ExecuteFn,
    /// Đổi cấu trúc bảng/màn/menu: chụp phiên bản cấu trúc TRƯỚC khi chạy (`STRUCTURE_TOOLS` của bản TS) để quay lui được.
    pub structure: bool,
}

/// Mọi thao tác ghi (cố ý KHÔNG có xoá cứng, xuất file, quản trị người dùng/vai trò).
pub fn all() -> [&'static ActionDef; 22] {
    use crate::tools::{
        act_contacts as c, act_records as r, act_tasks as t, import as i, structure as s, template as tp,
        view_tools as v,
    };
    [
        &c::CREATE_CONTACT,
        &c::ADD_CONTACT_NOTE,
        &c::UPDATE_CONTACT_STAGE,
        &t::CREATE_TASK,
        &c::ASSIGN_CONTACT,
        &r::CREATE_RECORD,
        &r::UPDATE_RECORD,
        &r::ARCHIVE_RECORD,
        &s::CREATE_OBJECTS,
        &s::CREATE_OBJECT,
        &s::UPDATE_OBJECT,
        &s::ADD_FIELD,
        &s::UPDATE_FIELD,
        &s::ARCHIVE_FIELD,
        &tp::INSTALL_OBJECT_TEMPLATE,
        &tp::SETUP_BUILD,
        &tp::PROPOSE_WORKSPACE,
        &i::IMPORT_RECORDS,
        &v::CREATE_VIEW,
        &v::UPDATE_VIEW,
        &v::SET_MENU,
        &s::RESTORE_STRUCTURE_VERSION,
    ]
}

pub fn find(name: &str) -> Option<&'static ActionDef> {
    all().into_iter().find(|a| a.name == name)
}

/// Nhãn và quyền của một loại đề xuất (cho `mod-ai-actions`).
pub fn info(name: &str) -> Option<(&'static str, &'static [&'static str])> {
    find(name).map(|a| (a.label, a.permissions))
}

/// Loại đề xuất này đổi cấu trúc (cần chụp phiên bản trước khi duyệt).
pub fn is_structure(name: &str) -> bool {
    find(name).is_some_and(|d| d.structure)
}

/// Chụp phiên bản cấu trúc TRƯỚC khi một thao tác cấu trúc chạy (gắn với id đề xuất). Không chụp được ⇒ lỗi và KHÔNG đổi gì.
pub async fn save_version(
    deps: &ToolDeps,
    principal: &Principal,
    draft_id: i32,
    tool: &str,
    summary: &str,
) -> Result<(), AppError> {
    let mut c = deps
        .conn(principal.company)
        .await
        .map_err(|e| AppError::internal(format!("{e:?}")))?;
    mod_custom::versions::save(&mut c, Some(draft_id), tool, summary, principal.user_id)
        .await
        .map(|_| ())
}

/// Chạy đề xuất đã duyệt với người duyệt thật; quyền đã kiểm ở `mod-ai-actions`.
pub async fn run_approved(
    name: &str,
    params: &Value,
    principal: &Principal,
    deps: &ToolDeps,
    draft_id: i32,
) -> Result<Value, AppError> {
    let Some(def) = find(name) else {
        return Err(HttpError::bad_request("Loại đề xuất không còn được hỗ trợ").into());
    };
    let cx = ActionCx { principal, deps };
    (def.execute)(params, &cx, draft_id).await.map_err(to_app_error)
}

/// Lỗi tool → lỗi HTTP cho luồng duyệt: lỗi người dùng/quyền/không thấy trả nguyên (< 500), còn lại là lỗi hệ thống.
pub fn to_app_error(e: ToolError) -> AppError {
    match e {
        ToolError::User(m) => HttpError::bad_request(m).into(),
        ToolError::NotFound => HttpError::not_found(NOT_FOUND_MSG).into(),
        ToolError::Forbidden(m) => HttpError::forbidden(m).into(),
        ToolError::Http { status, message } => HttpError::new(status, message).into(),
        ToolError::Plain(m) | ToolError::Internal(m) => AppError::internal(m),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Hàm dùng chung của các thao tác (`action-helpers.ts`)

pub fn internal(e: impl std::fmt::Debug) -> ToolError {
    ToolError::Internal(format!("{e:?}"))
}

/// `BadRequestException`: 400 với câu trả nguyên.
pub fn bad(msg: impl Into<String>) -> ToolError {
    ToolError::Http {
        status: 400,
        message: msg.into(),
    }
}

/// `HttpError` của DTO (validate) → lỗi tool.
pub fn http_err(e: HttpError) -> ToolError {
    app_err(AppError::Http(e))
}

fn invisible(c: char) -> bool {
    matches!(
        c,
        '\u{0}'..='\u{8}'
            | '\u{b}'
            | '\u{c}'
            | '\u{e}'..='\u{1f}'
            | '\u{200b}'..='\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2060}'..='\u{2069}'
            | '\u{34f}'
            | '\u{61c}'
            | '\u{feff}'
    )
}

/// Văn bản do AI gửi: NFC, bỏ ký tự điều khiển/vô hình, chuẩn hoá xuống dòng, cắt khoảng trắng và độ dài (UTF-16).
pub fn clean_text(s: &str, max: usize) -> String {
    let n: String = s.nfc().filter(|c| !invisible(*c)).collect();
    let n = n.replace("\r\n", "\n").replace('\r', "\n");
    slice16(trim_js(&n), max)
}

/// `cleanText` của giá trị JSON: chuỗi ⇒ làm sạch; số/bool ⇒ chuỗi của chúng; còn lại ⇒ rỗng.
pub fn clean_value(v: Option<&Value>, max: usize) -> String {
    match v {
        Some(Value::String(s)) => clean_text(s, max),
        Some(Value::Number(n)) => clean_text(&n.to_string(), max),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

/// Hiển thị cho người duyệt: che SĐT trong chuỗi tự do rồi cắt.
pub fn shown(s: &str, max: usize) -> String {
    let t = mask_phones_in_text(s);
    if t.encode_utf16().count() > max {
        format!("{}…", slice16(&t, max))
    } else {
        t
    }
}

type Fmt = for<'a> fn(&Captures<'a>) -> String;
type Rule = (Regex, Fmt);

fn rule(pattern: &str, f: Fmt) -> Rule {
    (Regex::new(pattern).expect("regex hợp lệ"), f)
}

/// Thông điệp MẶC ĐỊNH (tiếng Anh) của class-validator → câu tiếng Việt ngắn cho AI (); câu tự viết trong DTO giữ nguyên.
static VI_RULES: LazyLock<[Rule; 19]> = LazyLock::new(|| {
    [
        rule(r"^property (\S+) should not exist$", |m| {
            format!("Trường không tồn tại: {}", &m[1])
        }),
        rule(r"^(\S+) should not be (?:empty|null or undefined)$", |m| {
            format!("{}: bắt buộc", &m[1])
        }),
        rule(r"^(\S+) must be an integer number$", |m| {
            format!("{}: phải là số nguyên", &m[1])
        }),
        rule(
            r"^(\S+) must be a number conforming to the specified constraints$",
            |m| format!("{}: phải là số", &m[1]),
        ),
        rule(r"^(\S+) must be a positive number$", |m| {
            format!("{}: phải là số dương", &m[1])
        }),
        rule(r"^(\S+) must be a string$", |m| format!("{}: phải là chuỗi", &m[1])),
        rule(r"^(\S+) must be a boolean value$", |m| {
            format!("{}: phải là true/false", &m[1])
        }),
        rule(r"^(\S+) must be an array$", |m| format!("{}: phải là danh sách", &m[1])),
        rule(r"^(\S+) must be an email$", |m| {
            format!("{}: email không hợp lệ", &m[1])
        }),
        rule(r"^(\S+) must be a valid ISO 8601 date string$", |m| {
            format!("{}: phải là ngày ISO 8601 (vd 2026-12-01T09:00:00Z)", &m[1])
        }),
        rule(r"^(\S+) must be a Date instance$", |m| {
            format!("{}: phải là ngày", &m[1])
        }),
        rule(
            r"^(\S+) must be (longer|shorter) than or equal to (\d+) characters$",
            |m| {
                let kind = if &m[2] == "longer" {
                    "tối thiểu"
                } else {
                    "tối đa"
                };
                format!("{}: {kind} {} ký tự", &m[1], &m[3])
            },
        ),
        rule(r"^(\S+) must not be less than (-?[\d.]+)$", |m| {
            format!("{}: tối thiểu {}", &m[1], &m[2])
        }),
        rule(r"^(\S+) must not be greater than (-?[\d.]+)$", |m| {
            format!("{}: tối đa {}", &m[1], &m[2])
        }),
        rule(r"^(\S+) must be one of the following values: (.+)$", |m| {
            format!("{}: phải là một trong {}", &m[1], &m[2])
        }),
        rule(r"^(\S+) must be a valid enum value$", |m| {
            format!("{}: giá trị không hợp lệ", &m[1])
        }),
        rule(r"^(\S+) must match .+ regular expression$", |m| {
            format!("{}: sai định dạng", &m[1])
        }),
        rule(r"^(\S+) must contain (at least|no more than) (\d+) elements$", |m| {
            let kind = if &m[2] == "at least" {
                "tối thiểu"
            } else {
                "tối đa"
            };
            format!("{}: {kind} {} phần tử", &m[1], &m[3])
        }),
        rule(r"^each value in (\S+) (.+)$", |m| {
            let inner = vi_validation(&format!("x {}", &m[2]));
            format!(
                "{} (mỗi phần tử): {}",
                &m[1],
                inner.strip_prefix("x: ").unwrap_or(&inner)
            )
        }),
    ]
});

pub fn vi_validation(msg: &str) -> String {
    VI_RULES
        .iter()
        .find_map(|(re, f)| re.captures(msg).map(|c| f(&c)))
        .unwrap_or_else(|| msg.to_owned())
}

/// Kiểm tham số bằng ĐÚNG metadata của DTO web (, chế độ strict: trường lạ bị từ chối) như  bản TS;
/// lỗi ⇒ 400 gồm các câu (đã dịch) nối bằng "; ". Trả giá trị đã chuẩn hoá (chuyển kiểu, ).
pub fn validate_dto(name: &str, input: &Value) -> Result<Value, ToolError> {
    match validate_value(name, input, Mode::Strict) {
        Ok(v) => Ok(v),
        Err(e) => {
            let (status, body) = e.response(true);
            let messages = match body.message {
                Message::One(s) => vec![s],
                Message::Many(m) => m,
            };
            if status == 400 {
                let text: Vec<String> = messages.iter().map(|m| vi_validation(m)).collect();
                Err(bad(text.join("; ")))
            } else {
                Err(ToolError::Http {
                    status,
                    message: messages.join("; "),
                })
            }
        }
    }
}

/// Một dòng chi tiết; giá trị rỗng ⇒ bỏ.
pub fn line(label: &str, value: Option<&str>, max: usize) -> Option<Value> {
    value
        .filter(|v| !v.is_empty())
        .map(|v| json!({ "label": label, "value": shown(v, max) }))
}

pub fn lines(items: Vec<Option<Value>>) -> Vec<Value> {
    items.into_iter().flatten().collect()
}

/// Bỏ khoá `null` và chuỗi rỗng (`compact`).
pub fn compact(m: Map<String, Value>) -> Value {
    Value::Object(
        m.into_iter()
            .filter(|(_, v)| !v.is_null() && v.as_str() != Some(""))
            .collect(),
    )
}

/// Số nguyên dương trong khoảng int4 hoặc `null`.
pub fn int_or_null(v: Option<&Value>) -> Value {
    opt_int(v).map_or(Value::Null, |n| json!(n))
}

pub fn require_perm(p: &Principal, perm: &str) -> Result<(), ToolError> {
    if trinity_rbac::can(&p.grants, perm, None) {
        Ok(())
    } else {
        Err(ToolError::Http {
            status: 403,
            message: format!("Bạn không có quyền thực hiện thao tác này (cần quyền {perm})."),
        })
    }
}

/// Phạm vi chủ sở hữu của người gọi cho một quyền. Gọi TRƯỚC khi giữ kết nối.
pub async fn owner(cx: &ActionCx<'_>, perm: &str) -> Result<Option<OwnerIds>, ToolError> {
    let p = cx.principal;
    cx.deps
        .scopes
        .owner_ids(p.company, p.user_id, &p.grants, perm)
        .await
        .map_err(internal)
}

/// `owner` có phủ người dùng `id` không.
pub fn covers(owner: Option<&OwnerIds>, id: i32) -> bool {
    match owner {
        Some(OwnerIds::All) => true,
        Some(OwnerIds::Ids(ids)) => ids.contains(&id),
        None => false,
    }
}

/// Ghi lỗi `HttpError` (< 500) cho AI: câu thông báo của một `AppError`.
pub fn message_of(e: AppError) -> (u16, String) {
    let (status, body) = e.response(true);
    let m = match body.message {
        Message::One(s) => s,
        Message::Many(v) => v.join("; "),
    };
    (status, m)
}

/// Mục `setting_options` phải tồn tại, đúng nhóm và đang bật; trả nhãn.
pub async fn option_label(cx: &ActionCx<'_>, id: i32, group: &str, field: &str) -> Result<String, ToolError> {
    let mut conn = cx.deps.conn(cx.principal.company).await?;
    let row: Option<(String, String, bool)> =
        sqlx::query_as("SELECT group_key, label, is_active FROM setting_options WHERE id = $1")
            .bind(id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(internal)?;
    match row {
        Some((g, label, true)) if g == group => Ok(label),
        _ => Err(bad(format!(
            "{field} không hợp lệ — hãy lấy id đúng từ công cụ list_crm_options"
        ))),
    }
}

/// Khách đã đọc cho bản nháp.
pub struct ContactRow {
    pub id: i32,
    pub full_name: Option<String>,
    pub assigned_to: Option<i32>,
    pub stage_id: Option<i32>,
    pub stage_label: Option<String>,
}

/// Khách trong phạm vi quyền `perm`; ngoài phạm vi/không tồn tại ⇒ không thấy. `also_view`: LÚC TẠO NHÁP khách còn phải nằm trong
/// phạm vi ĐỌC (`contacts.view`): tên khách đi vào `summary` trả cho AI, AI không được biết hơn tool đọc cho phép.
pub async fn load_contact(cx: &ActionCx<'_>, id: i32, perm: &str, also_view: bool) -> Result<ContactRow, ToolError> {
    let allowed = owner(cx, perm).await?;
    let view = if also_view {
        Some(owner(cx, "contacts.view").await?)
    } else {
        None
    };
    let mut conn = cx.deps.conn(cx.principal.company).await?;
    let row: Option<(
        i32,
        Option<String>,
        Option<i32>,
        Option<i32>,
        Option<i32>,
        Option<String>,
    )> = sqlx::query_as(
        "SELECT c.id, c.full_name, c.assigned_to, c.created_by_id, c.stage_id, st.label
         FROM contacts c LEFT JOIN setting_options st ON st.id = c.stage_id
         WHERE c.id = $1 AND c.deleted_at IS NULL",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(internal)?;
    let Some((cid, full_name, assigned_to, created_by, stage_id, stage_label)) = row else {
        return Err(ToolError::NotFound);
    };
    let owners = [assigned_to, created_by];
    if trinity_rbac::assert_in_scope(allowed.as_ref(), &owners).is_err() {
        return Err(ToolError::NotFound);
    }
    if let Some(v) = view
        && trinity_rbac::assert_in_scope(v.as_ref(), &owners).is_err()
    {
        return Err(ToolError::NotFound);
    }
    Ok(ContactRow {
        id: cid,
        full_name,
        assigned_to,
        stage_id,
        stage_label,
    })
}

/// Tên hiển thị sau khi sửa: đổi tên ⇒ "cũ → mới", không đổi ⇒ tên cũ.
pub fn renamed(before: Option<&str>, after: Option<&str>) -> String {
    let b = trim_js(before.unwrap_or("")).to_owned();
    match after.map(trim_js) {
        Some(a) if !a.is_empty() && a != b => format!("{} → {a}", if b.is_empty() { "(trống)" } else { &b }),
        _ => b,
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Tool ghi: chạy ngay hoặc tạo đề xuất

/// Bộ chạy của một tool ghi.
pub struct ActionTool(pub &'static ActionDef);

impl ToolRunner for ActionTool {
    fn run<'a>(&'a self, args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        Box::pin(run_write(self.0, args, ctx))
    }
}

async fn run_write(def: &'static ActionDef, args: &Value, ctx: &ToolCtx<'_>) -> Result<ToolOutput, ToolError> {
    let cx = ActionCx {
        principal: ctx.principal,
        deps: ctx.deps,
    };
    if requires_approval(&cx).await {
        create_draft(def, args, ctx, &cx).await
    } else {
        execute_now(def, args, ctx, &cx).await
    }
}

/// "Yêu cầu duyệt thay đổi do AI": mặc định TẮT. Lỗi đọc ⇒ coi là BẬT (thà chờ duyệt còn hơn ghi nhầm).
async fn requires_approval(cx: &ActionCx<'_>) -> bool {
    let res: Result<Option<String>, String> = async {
        let mut c = cx.deps.conn(cx.principal.company).await.map_err(|e| format!("{e:?}"))?;
        sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = $1")
            .bind(REQUIRE_APPROVAL_KEY)
            .fetch_optional(&mut *c)
            .await
            .map_err(|e| e.to_string())
    }
    .await;
    match res {
        Ok(v) => v.as_deref() == Some("true"),
        Err(e) => {
            tracing::error!("Đọc cài đặt duyệt AI lỗi, dùng chế độ chờ duyệt: {e}");
            true
        }
    }
}

struct Created {
    id: i32,
    summary: String,
    expires_at: DateTime<Utc>,
    duplicate: bool,
}

fn wait_message(what: &str, max: u32, retry: u64) -> ToolError {
    ToolError::User(format!("{what} (tối đa {max}/phút). Thử lại sau {retry} giây."))
}

async fn create_draft(
    def: &'static ActionDef,
    args: &Value,
    ctx: &ToolCtx<'_>,
    cx: &ActionCx<'_>,
) -> Result<ToolOutput, ToolError> {
    let p = cx.principal;
    let hit = ctx.limits.draft(p.company.id(), p.user_id);
    if !hit.allowed {
        return Err(wait_message(
            "Tạo đề xuất quá nhanh",
            DRAFTS_PER_MINUTE,
            hit.retry_after_sec,
        ));
    }
    let prepared = (def.prepare)(args, cx).await?;
    let created = insert_draft(cx, def, &prepared).await?;
    if !created.duplicate {
        notify(cx, created.id, &prepared.summary).await;
    }
    let mut e = AuditEntry::new(Channel::Mcp, "ai_action.draft", AuditStatus::Ok);
    e.client_id = Some(p.client_id.clone());
    e.user_id = Some(p.user_id);
    e.resource = Some("ai_action_draft".to_owned());
    e.resource_id = Some(created.id.to_string());
    e.metadata = Some(json!({ "tool": def.name, "duplicate": created.duplicate, "summary": prepared.summary }));
    audit_log(cx, &e).await;
    let review_url = format!("{}/ai-actions?id={}", ctx.base_url, created.id);
    let message = format!(
        "Đã tạo đề xuất #{}, chờ người dùng duyệt tại {review_url}. Thao tác chưa được thực hiện cho tới khi người dùng duyệt.",
        created.id
    );
    wrapped(&json!({
        "action_id": created.id, "status": "pending", "summary": created.summary,
        "expires_at": js_iso_string(created.expires_at), "review_url": review_url, "message": message,
        "duplicate": created.duplicate,
    }))
}

/// Chèn đề xuất chờ duyệt trong một giao dịch, tuần tự hoá theo người dùng để đếm + chèn không cùng vượt trần.
async fn insert_draft(cx: &ActionCx<'_>, def: &ActionDef, pr: &Prepared) -> Result<Created, ToolError> {
    let p = cx.principal;
    let t = cx.deps.db.tenant(p.company).await.map_err(internal)?;
    let mut tx = t.begin().await.map_err(internal)?;
    sqlx::query("SELECT pg_advisory_xact_lock($1, $2)")
        .bind(ADVISORY_NS)
        .bind(p.user_id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    let params = js_json(&pr.params);
    let dup: Option<(i32, String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT id, summary, expires_at FROM ai_action_drafts
         WHERE user_id = $1 AND status = 'pending' AND expires_at > now() AND client_id = $2 AND tool = $3
           AND params = $4::text::jsonb
         ORDER BY id LIMIT 1",
    )
    .bind(p.user_id)
    .bind(&p.client_id)
    .bind(def.name)
    .bind(&params)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?;
    if let Some((id, summary, expires_at)) = dup {
        return Ok(Created {
            id,
            summary,
            expires_at,
            duplicate: true,
        });
    }
    let pending: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM ai_action_drafts WHERE user_id = $1 AND status = 'pending' AND expires_at > now()",
    )
    .bind(p.user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    let by_client: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM ai_action_drafts
         WHERE user_id = $1 AND status = 'pending' AND expires_at > now() AND client_id = $2",
    )
    .bind(p.user_id)
    .bind(&p.client_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    if by_client >= MAX_PENDING_PER_CLIENT {
        return Err(ToolError::User(format!(
            "Ứng dụng này đang có {by_client} đề xuất chờ duyệt (tối đa {MAX_PENDING_PER_CLIENT}). Hãy đợi người dùng duyệt/từ chối rồi mới tạo thêm. KHÔNG tạo hàng loạt."
        )));
    }
    if pending >= MAX_PENDING_DRAFTS {
        return Err(ToolError::User(format!(
            "Bạn đang có {pending} đề xuất chờ duyệt (tối đa {MAX_PENDING_DRAFTS}). Hãy duyệt/từ chối bớt trong Trinity rồi thử lại. KHÔNG tạo thêm hàng loạt."
        )));
    }
    let summary = slice16(&pr.summary, 1000);
    let (id, expires_at): (i32, DateTime<Utc>) = sqlx::query_as(
        "INSERT INTO ai_action_drafts (user_id, client_id, tool, params, summary, details, impact, expires_at)
         VALUES ($1, $2, $3, $4::text::jsonb, $5, $6::text::jsonb, $7::text::jsonb, now() + interval '24 hours')
         RETURNING id, expires_at",
    )
    .bind(p.user_id)
    .bind(&p.client_id)
    .bind(def.name)
    .bind(&params)
    .bind(&summary)
    .bind(js_json(&Value::Array(pr.details.clone())))
    .bind(pr.impact.as_ref().map(js_json))
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Created {
        id,
        summary,
        expires_at,
        duplicate: false,
    })
}

/// Thông báo "AI đề xuất một thao tác": ghi phụ, giao dịch riêng, lỗi chỉ ghi log.
async fn notify(cx: &ActionCx<'_>, id: i32, summary: &str) {
    let run = async {
        let t = cx
            .deps
            .db
            .tenant(cx.principal.company)
            .await
            .map_err(|e| format!("{e:?}"))?;
        let mut tx = t.begin().await.map_err(|e| format!("{e:?}"))?;
        let item = NewNotification {
            recipient_id: cx.principal.user_id,
            event_type: "ai_action.created".to_owned(),
            title: "AI đề xuất một thao tác — chờ bạn duyệt".to_owned(),
            body: shown(summary, 200),
            action_url: Some(format!("/ai-actions?id={id}")),
        };
        create_notification(&mut tx, &[item])
            .await
            .map_err(|e| format!("{e:?}"))?;
        tx.commit().await.map_err(|e| format!("{e:?}"))
    };
    if let Err(e) = run.await {
        tracing::error!("Không gửi được thông báo đề xuất AI #{id}: {e}");
    }
}

async fn audit_log(cx: &ActionCx<'_>, entry: &AuditEntry) {
    if let Ok(mut c) = cx.deps.conn(cx.principal.company).await {
        audit::log(&mut c, entry).await;
    }
}

/// Câu lỗi lưu vào đề xuất (đã che SĐT khi hiển thị).
fn error_text(e: &ToolError) -> String {
    match e {
        ToolError::User(m) | ToolError::Forbidden(m) | ToolError::Plain(m) => m.clone(),
        ToolError::NotFound => NOT_FOUND_MSG.to_owned(),
        ToolError::Http { message, .. } => message.clone(),
        ToolError::Internal(_) => "Lỗi hệ thống khi thực hiện đề xuất".to_owned(),
    }
}

/// GHI THẲNG: cùng `prepare` + `execute` của luồng duyệt, rồi ghi `ai_action_drafts` để có lịch sử.
async fn execute_now(
    def: &'static ActionDef,
    args: &Value,
    ctx: &ToolCtx<'_>,
    cx: &ActionCx<'_>,
) -> Result<ToolOutput, ToolError> {
    let p = cx.principal;
    let hit = ctx.limits.write(p.company.id(), p.user_id);
    if !hit.allowed {
        return Err(wait_message(
            "Ghi dữ liệu quá nhanh",
            WRITES_PER_MINUTE,
            hit.retry_after_sec,
        ));
    }
    let app = ctx.limits.write_app(p.company.id(), p.user_id, &p.client_id);
    if !app.allowed {
        return Err(wait_message(
            "Ứng dụng AI này ghi quá nhanh",
            WRITES_PER_CLIENT_PER_MINUTE,
            app.retry_after_sec,
        ));
    }
    let prepared = (def.prepare)(args, cx).await?;
    let summary = slice16(&prepared.summary, 1000);
    let id = {
        let mut c = cx.deps.conn(p.company).await?;
        sqlx::query_scalar::<_, i32>(
            "INSERT INTO ai_action_drafts (user_id, client_id, tool, params, summary, details, impact, status, decided_at, expires_at)
             VALUES ($1, $2, $3, $4::text::jsonb, $5, $6::text::jsonb, $7::text::jsonb, 'approved', now(), now() + interval '24 hours')
             RETURNING id",
        )
        .bind(p.user_id)
        .bind(&p.client_id)
        .bind(def.name)
        .bind(js_json(&prepared.params))
        .bind(&summary)
        .bind(js_json(&Value::Array(prepared.details.clone())))
        .bind(prepared.impact.as_ref().map(js_json))
        .fetch_one(&mut *c)
        .await
        .map_err(internal)?
    };
    // Chụp cấu trúc TRƯỚC khi đổi để quay lui được; không chụp được thì KHÔNG đổi (như bản TS).
    if def.structure
        && let Err(e) = save_version(cx.deps, p, id, def.name, &summary).await
    {
        let e = internal(e);
        mark_failed(cx, def, id, &summary, &e).await;
        return Err(e);
    }
    let result = match (def.execute)(&prepared.params, cx, id).await {
        Ok(r) => r,
        Err(e) => {
            mark_failed(cx, def, id, &summary, &e).await;
            return Err(e);
        }
    };
    // Đã thực thi xong: lỗi ghi lịch sử KHÔNG được biến thành "thất bại" (thao tác đã xảy ra).
    save_result(cx, id, &result).await;
    let mut e = AuditEntry::new(Channel::Mcp, "ai_action.execute", AuditStatus::Ok);
    e.client_id = Some(p.client_id.clone());
    e.user_id = Some(p.user_id);
    e.resource = Some("ai_action_draft".to_owned());
    e.resource_id = Some(id.to_string());
    e.metadata = Some(json!({ "tool": def.name, "summary": summary }));
    audit_log(cx, &e).await;
    wrapped(&json!({
        "action_id": id, "status": "executed", "summary": summary, "result": result,
        "message": format!("Đã thực hiện: {summary}{}", row_error_note(&result)),
    }))
}

/// Vài dòng lỗi đầu của `result.errors` `[{row, reason}]` (import) để nêu ngay trong `message` (`rowErrorNote` của bản TS).
fn row_error_note(result: &Value) -> String {
    let Some(errs) = result.get("errors").and_then(Value::as_array).filter(|a| !a.is_empty()) else {
        return String::new();
    };
    let total = result
        .get("error_total")
        .and_then(Value::as_u64)
        .unwrap_or(errs.len() as u64);
    let mut rows: Vec<(i64, String)> = errs
        .iter()
        .map(|e| {
            let row = e.get("row").and_then(Value::as_i64).unwrap_or(0);
            let obj = e
                .get("object")
                .and_then(Value::as_str)
                .map(|o| format!("{o} "))
                .unwrap_or_default();
            let reason = e.get("reason").and_then(Value::as_str).unwrap_or_default();
            let reason = if reason.chars().count() > 80 {
                format!("{}…", reason.chars().take(80).collect::<String>())
            } else {
                reason.to_owned()
            };
            (row, format!("{obj}dòng {row}: {reason}"))
        })
        .collect();
    rows.sort_by_key(|r| r.0);
    let preview = rows.iter().take(3).map(|r| r.1.as_str()).collect::<Vec<_>>().join("; ");
    format!(
        ". {total} dòng lỗi không ghi: {preview}{}",
        if total > 3 { " … (xem result.errors)" } else { "" }
    )
}

async fn save_result(cx: &ActionCx<'_>, id: i32, result: &Value) {
    let res = async {
        let mut c = cx.deps.conn(cx.principal.company).await.map_err(|e| format!("{e:?}"))?;
        sqlx::query("UPDATE ai_action_drafts SET status = 'executed', result = $2::text::jsonb WHERE id = $1")
            .bind(id)
            .bind(js_json(result))
            .execute(&mut *c)
            .await
            .map_err(|e| e.to_string())
    };
    if let Err(e) = res.await {
        tracing::error!("Ghi kết quả thao tác AI #{id} lỗi: {e}");
    }
}

async fn mark_failed(cx: &ActionCx<'_>, def: &ActionDef, id: i32, summary: &str, err: &ToolError) {
    let p = cx.principal;
    let msg = shown(&error_text(err), 900);
    if let ToolError::Internal(m) = err {
        tracing::error!("Thao tác AI #{id} lỗi: {m}");
    }
    if let Ok(mut c) = cx.deps.conn(p.company).await {
        let _ = sqlx::query("UPDATE ai_action_drafts SET status = 'failed', error = $2 WHERE id = $1")
            .bind(id)
            .bind(&msg)
            .execute(&mut *c)
            .await;
    }
    let denied = matches!(
        err,
        ToolError::NotFound | ToolError::Forbidden(_) | ToolError::Http { status: 403, .. }
    );
    let mut e = AuditEntry::new(
        Channel::Mcp,
        "ai_action.execute",
        if denied {
            AuditStatus::Denied
        } else {
            AuditStatus::Error
        },
    );
    e.client_id = Some(p.client_id.clone());
    e.user_id = Some(p.user_id);
    e.resource = Some("ai_action_draft".to_owned());
    e.resource_id = Some(id.to_string());
    e.error = Some(msg);
    e.metadata = Some(json!({ "tool": def.name, "summary": summary }));
    audit_log(cx, &e).await;
}

// ---------------------------------------------------------------------------------------------------------------
// get_action_status

/// Trạng thái hiệu lực (không phụ thuộc job): `pending` quá hạn ⇒ `expired`; `approved` chưa có `result` ⇒ `executing` trong cửa sổ
/// ngắn, quá cửa sổ ⇒ `failed`.
fn effective_status(
    status: &str,
    has_result: bool,
    decided_at: Option<DateTime<Utc>>,
    expires_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> String {
    if status == "pending" && expires_at <= now {
        return "expired".to_owned();
    }
    if status == "approved"
        && !has_result
        && let Some(at) = decided_at
    {
        let stale = now - at > Duration::minutes(EXECUTION_STALE_MINUTES);
        return (if stale { "failed" } else { "executing" }).to_owned();
    }
    status.to_owned()
}

type StatusRow = (
    i32,
    String,
    String,
    String,
    Option<String>,
    Option<DateTime<Utc>>,
    DateTime<Utc>,
);

/// `get_action_status`: chỉ đề xuất của CHÍNH người dùng + CHÍNH ứng dụng đã tạo nó.
pub fn get_action_status<'a>(args: &'a Value, ctx: &'a ToolCtx<'a>) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let p = ctx.principal;
        let action_id = opt_int(args.get("action_id"));
        let alias = opt_int(args.get("id"));
        let Some(id) = action_id.or(alias) else {
            return Err(ToolError::User(
                "Cần action_id (số nguyên dương) — lấy từ kết quả của tool ghi.".into(),
            ));
        };
        if action_id.is_some() && alias.is_some() && action_id != alias {
            return Err(ToolError::User("action_id và id khác nhau — chỉ gửi action_id.".into()));
        }
        let row: Option<StatusRow> = {
            let mut c = ctx.deps.conn(p.company).await?;
            sqlx::query_as(
                "SELECT id, tool, status, summary, result::text, decided_at, expires_at FROM ai_action_drafts
                 WHERE id = $1 AND user_id = $2 AND client_id = $3",
            )
            .bind(id)
            .bind(p.user_id)
            .bind(&p.client_id)
            .fetch_optional(&mut *c)
            .await
            .map_err(internal)?
        };
        let Some((rid, tool, status, summary, result, decided_at, expires_at)) = row else {
            return Err(ToolError::NotFound);
        };
        let st = effective_status(&status, result.is_some(), decided_at, expires_at, Utc::now());
        // Lý do lỗi CHI TIẾT chỉ người duyệt thấy trên web: trả cho AI thì thành oracle dò dữ liệu.
        let error = if st == "failed" {
            json!("Không thực hiện được — lý do đã hiển thị cho người dùng trong Trinity (mục Hoạt động AI).")
        } else {
            Value::Null
        };
        let result_json = result
            .as_deref()
            .and_then(|t| serde_json::from_str::<Value>(t).ok())
            .unwrap_or(Value::Null);
        wrapped(&json!({
            "id": rid, "tool": tool, "status": st, "summary": summary, "result": result_json, "error": error,
            "decided_at": decided_at.map_or(Value::Null, |t| json!(js_iso_string(t))),
            "expires_at": js_iso_string(expires_at),
        }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn khong_co_tool_xoa_va_ten_khong_trung() {
        let names: Vec<&str> = all().iter().map(|a| a.name).collect();
        assert_eq!(names.len(), 22);
        let mut sorted = names.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), names.len());
        for n in &names {
            for w in ["delete", "remove", "destroy", "purge", "drop"] {
                assert!(!n.contains(w), "{n}");
            }
            assert!(find(n).is_some());
        }
        assert!(find("delete_contact").is_none());
    }

    #[test]
    fn lam_sach_van_ban_ai() {
        assert_eq!(clean_text("  a\u{200b}b\r\nc  ", 100), "ab\nc");
        assert_eq!(clean_text("abcdef", 3), "abc");
        assert_eq!(clean_text("\u{0}\u{1f}", 10), "");
        assert_eq!(clean_value(Some(&json!(12)), 10), "12");
        assert_eq!(clean_value(Some(&json!(null)), 10), "");
    }

    #[test]
    fn trang_thai_hieu_luc() {
        let now = Utc::now();
        let later = now + Duration::hours(1);
        let earlier = now - Duration::hours(1);
        assert_eq!(effective_status("pending", false, None, earlier, now), "expired");
        assert_eq!(effective_status("pending", false, None, later, now), "pending");
        assert_eq!(effective_status("approved", false, Some(now), later, now), "executing");
        assert_eq!(
            effective_status("approved", false, Some(now - Duration::minutes(6)), later, now),
            "failed"
        );
        assert_eq!(
            effective_status("approved", true, Some(earlier), later, now),
            "approved"
        );
        assert_eq!(effective_status("executed", true, None, earlier, now), "executed");
    }

    #[test]
    fn tom_tat_che_sdt_va_cat() {
        assert_eq!(shown("gọi 0901234567", 300), "gọi ***567");
        assert_eq!(shown("abcdef", 3), "abc…");
        assert_eq!(renamed(Some("A"), Some("B")), "A → B");
        assert_eq!(renamed(Some("A"), Some("A")), "A");
        assert_eq!(renamed(None, Some("B")), "(trống) → B");
        assert_eq!(renamed(Some("A"), None), "A");
    }

    #[test]
    fn pham_vi_phu_nguoi() {
        assert!(covers(Some(&OwnerIds::All), 5));
        assert!(covers(Some(&OwnerIds::Ids(vec![1, 5])), 5));
        assert!(!covers(Some(&OwnerIds::Ids(vec![1])), 5));
        assert!(!covers(None, 5));
    }

    #[test]
    fn thao_tac_cau_truc_duoc_chup_phien_ban() {
        let mut st: Vec<&str> = all().iter().filter(|a| a.structure).map(|a| a.name).collect();
        st.sort_unstable();
        assert_eq!(st.len(), 13);
        assert!(is_structure("create_view") && is_structure("restore_structure_version"));
        // Nhập dữ liệu và thao tác bản ghi/khách/việc không đổi cấu trúc.
        for n in [
            "import_records",
            "create_record",
            "create_contact",
            "create_task",
            "nope",
        ] {
            assert!(!is_structure(n), "{n}");
        }
    }
}
