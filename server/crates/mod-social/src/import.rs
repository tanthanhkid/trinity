//! Nhập nhiều bài từ CSV hoặc danh sách dòng (`social-import.service.ts`): kiểm từng dòng (không ném), gom lỗi theo dòng,
//! băm `plan_hash`; nhập thật kiểm lại và so mã (khác ⇒ 409) rồi tạo nháp hoặc bài hẹn giờ TỪNG DÒNG ĐỘC LẬP.
//!
//! Tạo/kiểm bài, nháp và khung hàng đợi đi qua các cổng ở [`crate::ports`]; DB chỉ đọc `social_accounts` và
//! `social_media_assets` (mỗi bước một kết nối ngắn, không giữ khi gọi cổng).
//!
//! Lệch Node: `plan_hash` băm JSON của serde_json (khoá sắp theo chữ cái) nên KHÁC mã bản Node cho cùng dữ liệu — mã chỉ
//! so Rust với Rust trong một lượt "kiểm tra rồi nhập", không lưu; lượt kiểm tra mở trên bản Node rồi nhập trên bản Rust
//! (lúc đổi sở hữu) sẽ nhận 409 và người dùng bấm "Kiểm tra" lại.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use trinity_db::pg_error::app_error;
use trinity_db::{TenantConn, TenantDb};
use trinity_kernel::error::{AppError, HttpError, Message};
use trinity_kernel::vn_time::js_iso_string;

use crate::config::SOCIAL_NETWORKS;
use crate::csv::{IMPORT_MAX_ROWS, ImportRowInput, parse_csv, parse_vn_time};
use crate::limits::{MAX_MEDIA_PER_POST, MAX_SCHEDULE_AHEAD_MS, MAX_TARGETS};
use crate::ports::{CreateFailure, DraftsPort, NO_QUEUE_SLOTS, PostInput, PostsPort, QueuePort, status_of};
use crate::recur::{MINUTE_MS, TemplateTarget, TemplateUtm};
use crate::utm::normalize_campaign;

/// Lúc nhập thật: giờ hẹn còn dưới ngần này thì bỏ dòng (tránh `create` coi là đã qua và đăng ngay).
const IMPORT_MIN_LEAD_MS: i64 = 20_000;
const GENERIC_ROW_ERROR: &str = "Không kiểm tra được dòng này lúc này — thử lại sau.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportMode {
    /// Tạo nháp.
    Drafts,
    /// Tạo bài hẹn giờ (mọi dòng cần giờ hoặc "hàng đợi").
    Schedule,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PreviewChannel {
    pub account_id: i32,
    pub name: String,
    pub network: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RowPreview {
    pub channels: Vec<PreviewChannel>,
    pub scheduled_at: Option<String>,
    pub use_queue: bool,
    pub content_excerpt: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RowPlan {
    /// Số dòng (CSV: dòng trong tệp, tiêu đề là dòng 1).
    pub row: usize,
    pub ok: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub preview: RowPreview,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportPlan {
    pub mode: ImportMode,
    /// Băm các dòng đã chuẩn hoá + chế độ; gửi lại khi nhập để chắc nhập đúng cái đã xem.
    pub plan_hash: String,
    pub total: usize,
    pub ok_count: usize,
    pub error_count: usize,
    pub rows: Vec<RowPlan>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unknown_columns: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Created {
    pub row: usize,
    pub id: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Skipped {
    pub row: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportResult {
    pub mode: ImportMode,
    pub created: Vec<Created>,
    pub skipped: Vec<Skipped>,
}

/// Dòng nhập có cấu trúc (tool MCP) trước khi chuẩn về dạng dùng chung với CSV.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StructuredRow {
    pub content: Option<String>,
    pub account_ids: Vec<i32>,
    pub scheduled_at: Option<String>,
    pub use_queue: bool,
    pub media_keys: Vec<String>,
    pub first_comment: Option<String>,
    pub utm_campaign: Option<String>,
}

fn non_empty(s: &Option<String>) -> Option<String> {
    s.as_deref().map(str::trim).filter(|t| !t.is_empty()).map(str::to_owned)
}

/// Dòng nhập có cấu trúc (MCP) → dạng dùng chung với CSV; số dòng là thứ tự 1…n.
pub fn rows_from_structured(rows: &[StructuredRow]) -> Vec<ImportRowInput> {
    rows.iter()
        .enumerate()
        .map(|(i, r)| ImportRowInput {
            row: i + 1,
            content: non_empty(&r.content),
            channels: r.account_ids.iter().map(ToString::to_string).collect(),
            scheduled_at: non_empty(&r.scheduled_at),
            use_queue: r.use_queue,
            media: r
                .media_keys
                .iter()
                .map(|k| k.trim().to_owned())
                .filter(|k| !k.is_empty())
                .collect(),
            first_comment: non_empty(&r.first_comment),
            utm_campaign: non_empty(&r.utm_campaign),
        })
        .collect()
}

/// Các cổng nhập CSV dùng.
pub struct ImportPorts<'a, P, D, Q> {
    pub posts: &'a P,
    pub drafts: &'a D,
    pub queue: &'a Q,
}

/// Khi chưa có dịch vụ hàng đợi: không khung nào, dòng "hàng đợi" báo [`NO_QUEUE_SLOTS`].
pub struct NoQueue;

impl QueuePort for NoQueue {
    async fn next_free(&self, _n: usize) -> Result<Vec<DateTime<Utc>>, AppError> {
        Ok(Vec::new())
    }
}

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

async fn conn(t: &TenantDb) -> Result<TenantConn, AppError> {
    t.acquire().await.map_err(AppError::internal)
}

fn bad(m: impl Into<String>) -> AppError {
    HttpError::bad_request(Message::One(m.into())).into()
}

/// Lỗi 4xx của dịch vụ là lỗi dòng (hiện cho người dùng); lỗi khác không lộ chi tiết nội bộ.
fn row_message(e: &AppError) -> String {
    match e {
        AppError::Http(h) if h.status() < 500 => match h.body().message {
            Message::One(s) => s,
            Message::Many(v) => v.join(", "),
        },
        _ => GENERIC_ROW_ERROR.to_owned(),
    }
}

fn excerpt(s: &str) -> String {
    let t = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() > 80 {
        format!("{}…", t.chars().take(79).collect::<String>())
    } else {
        t
    }
}

fn head(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

#[derive(Debug, sqlx::FromRow)]
struct Acct {
    id: i32,
    name: String,
    network: String,
    status: String,
}

struct Ctx {
    accounts: Vec<Acct>,
    by_id: HashMap<i32, usize>,
    by_name: HashMap<String, Vec<usize>>,
    by_lower: HashMap<String, Vec<usize>>,
    keys: HashSet<String>,
    by_asset_name: HashMap<String, Vec<String>>,
}

async fn load_ctx(db_: &TenantDb, rows: &[ImportRowInput]) -> Result<Ctx, AppError> {
    let mut c = conn(db_).await?;
    // Chỉ kênh của mạng còn hỗ trợ: tên kênh YouTube/TikTok cũ trong tệp nhập báo "Không tìm thấy kênh".
    let networks: Vec<String> = SOCIAL_NETWORKS.iter().map(ToString::to_string).collect();
    let accounts = sqlx::query_as::<_, Acct>(
        "SELECT id, name, network, status FROM social_accounts WHERE status <> 'disabled' AND network = ANY($1) ORDER BY id",
    )
    .bind(&networks)
    .fetch_all(&mut *c)
    .await
    .map_err(db)?;
    // Tệp: khoá trước, rồi tên gốc trong thư viện (nhiều tệp trùng tên ⇒ lấy tệp mới nhất + cảnh báo).
    let mut seen = HashSet::new();
    let tokens: Vec<String> = rows
        .iter()
        .flat_map(|r| r.media.iter())
        .filter(|t| seen.insert((*t).clone()))
        .cloned()
        .collect();
    let assets: Vec<(String, String)> = if tokens.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as(
            "SELECT key, name FROM social_media_assets WHERE hidden_at IS NULL AND (key = ANY($1) OR name = ANY($1)) ORDER BY id DESC",
        )
        .bind(&tokens)
        .fetch_all(&mut *c)
        .await
        .map_err(db)?
    };
    drop(c);
    let mut by_id = HashMap::new();
    let mut by_name: HashMap<String, Vec<usize>> = HashMap::new();
    let mut by_lower: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, a) in accounts.iter().enumerate() {
        by_id.insert(a.id, i);
        by_name.entry(a.name.clone()).or_default().push(i);
        by_lower.entry(a.name.to_lowercase()).or_default().push(i);
    }
    let keys = assets.iter().map(|(k, _)| k.clone()).collect();
    let mut by_asset_name: HashMap<String, Vec<String>> = HashMap::new();
    for (k, n) in assets {
        by_asset_name.entry(n).or_default().push(k);
    }
    Ok(Ctx {
        accounts,
        by_id,
        by_name,
        by_lower,
        keys,
        by_asset_name,
    })
}

struct Item {
    plan: RowPlan,
    input: PostInput,
    /// Dạng chuẩn hoá để băm (không gồm khung hàng đợi — khung đổi theo thời gian).
    norm: Value,
    queue: bool,
}

fn plan_row(r: &ImportRowInput, mode: ImportMode, now_ms: i64, cx: &Ctx) -> Item {
    let mut errors: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let content = r.content.as_deref().unwrap_or("").trim().to_owned();
    let mut chosen: Vec<&Acct> = Vec::new();
    for tok in &r.channels {
        let id = if !tok.is_empty() && tok.bytes().all(|b| b.is_ascii_digit()) {
            tok.parse::<i32>().ok()
        } else {
            None
        };
        let mut found = id.and_then(|i| cx.by_id.get(&i)).map(|i| &cx.accounts[*i]);
        // Số vừa là id một kênh vừa là tên kênh khác ⇒ không đoán.
        if let Some(a) = found
            && cx
                .by_name
                .get(tok)
                .is_some_and(|v| v.iter().any(|i| cx.accounts[*i].id != a.id))
        {
            errors.push(format!(
                "\"{tok}\" vừa là id kênh vừa là tên một kênh khác — ghi rõ tên hoặc id."
            ));
            continue;
        }
        if found.is_none() {
            let exact = cx.by_name.get(tok).filter(|v| !v.is_empty());
            let loose = exact.or_else(|| cx.by_lower.get(&tok.to_lowercase()));
            let loose: &[usize] = loose.map_or(&[], Vec::as_slice);
            if loose.len() > 1 {
                errors.push(format!("Tên kênh \"{tok}\" trùng nhiều kênh — dùng id kênh."));
                continue;
            }
            found = loose.first().map(|i| &cx.accounts[*i]);
        }
        let Some(a) = found else {
            errors.push(format!("Không tìm thấy kênh \"{}\".", head(tok, 80)));
            continue;
        };
        if chosen.iter().any(|c| c.id == a.id) {
            warnings.push(format!("Kênh \"{}\" ghi nhiều lần — chỉ tính một.", a.name));
        } else {
            chosen.push(a);
        }
    }
    if chosen.len() > MAX_TARGETS {
        errors.push(format!("Tối đa {MAX_TARGETS} kênh mỗi bài."));
    }
    if mode == ImportMode::Schedule && chosen.is_empty() && r.channels.is_empty() {
        errors.push("Cần ít nhất một kênh.".to_owned());
    }
    if mode == ImportMode::Drafts {
        for a in &chosen {
            if a.status != "active" {
                warnings.push(format!("Kênh \"{}\" cần liên kết lại trước khi đăng.", a.name));
            }
        }
    }

    // Giờ đăng.
    let mut at: Option<DateTime<Utc>> = None;
    let queue = r.use_queue;
    if queue && r.scheduled_at.is_some() {
        errors.push("Chỉ chọn một: giờ cụ thể hoặc 'hàng đợi'.".to_owned());
    } else if let Some(s) = &r.scheduled_at {
        match parse_vn_time(s) {
            Ok(t) => at = Some(t),
            Err(m) => errors.push(m),
        }
    }
    if let Some(t) = at {
        let ahead = t.timestamp_millis() - now_ms;
        match mode {
            ImportMode::Schedule => {
                if ahead <= MINUTE_MS {
                    errors.push("Giờ hẹn phải sau bây giờ ít nhất 1 phút.".to_owned());
                } else if ahead > MAX_SCHEDULE_AHEAD_MS {
                    errors.push("Chỉ hẹn trước tối đa 90 ngày.".to_owned());
                }
            }
            ImportMode::Drafts => {
                if ahead < 0 {
                    warnings.push("Giờ hẹn đã qua — sửa lại trước khi đăng nháp.".to_owned());
                } else if ahead > MAX_SCHEDULE_AHEAD_MS {
                    warnings.push("Giờ hẹn quá 90 ngày — sửa lại trước khi đăng nháp.".to_owned());
                }
            }
        }
    }
    if mode == ImportMode::Schedule && at.is_none() && !queue {
        errors.push("Cần giờ đăng hoặc 'hàng đợi'.".to_owned());
    }

    // Tệp.
    let mut media: Vec<String> = Vec::new();
    for tok in &r.media {
        let key = if cx.keys.contains(tok) {
            Some(tok.clone())
        } else if let Some(list) = cx.by_asset_name.get(tok).filter(|l| !l.is_empty()) {
            if list.len() > 1 {
                warnings.push(format!("Có {} tệp tên \"{tok}\" — dùng tệp mới nhất.", list.len()));
            }
            Some(list[0].clone())
        } else if tok.starts_with("social/") {
            Some(tok.clone())
        } else {
            errors.push(format!(
                "Không thấy tệp \"{}\" trong thư viện (khoá hoặc tên tệp gốc).",
                head(tok, 80)
            ));
            None
        };
        if let Some(k) = key
            && !media.contains(&k)
        {
            media.push(k);
        }
    }
    if media.len() > MAX_MEDIA_PER_POST {
        errors.push(format!("Tối đa {MAX_MEDIA_PER_POST} tệp mỗi bài."));
    }
    if content.is_empty() && media.is_empty() && r.media.is_empty() {
        errors.push("Cần nội dung hoặc ảnh/video.".to_owned());
    }

    // UTM.
    let mut utm: Option<TemplateUtm> = None;
    if let Some(c) = &r.utm_campaign {
        match normalize_campaign(c) {
            Ok(campaign) => utm = Some(TemplateUtm { campaign, content: None }),
            Err(m) => errors.push(m),
        }
    }

    // Tuỳ chọn riêng từng mạng.
    let first_comment = r.first_comment.as_deref();
    if first_comment.is_some() && !chosen.iter().any(|a| a.network == "facebook") {
        warnings.push("Không có kênh Facebook — bỏ qua bình luận đầu.".to_owned());
    }
    let targets: Vec<TemplateTarget> = chosen
        .iter()
        .map(|a| {
            let options = match first_comment {
                Some(fc) if a.network == "facebook" => {
                    let mut m = serde_json::Map::new();
                    m.insert("first_comment".to_owned(), Value::String(fc.to_owned()));
                    Some(m)
                }
                _ => None,
            };
            TemplateTarget {
                account_id: a.id,
                caption: None,
                options,
            }
        })
        .collect();

    let plan = RowPlan {
        row: r.row,
        ok: false,
        errors,
        warnings,
        preview: RowPreview {
            channels: chosen
                .iter()
                .map(|a| PreviewChannel {
                    account_id: a.id,
                    name: a.name.clone(),
                    network: a.network.clone(),
                })
                .collect(),
            scheduled_at: at.map(js_iso_string),
            use_queue: queue,
            content_excerpt: excerpt(&content),
        },
    };
    let norm = json!({
        "row": r.row,
        "content": content,
        "account_ids": chosen.iter().map(|a| a.id).collect::<Vec<_>>(),
        "scheduled_at": at.map(js_iso_string),
        "use_queue": queue,
        "media_keys": media,
        "first_comment": r.first_comment,
        "utm_campaign": utm.as_ref().map(|u| u.campaign.clone()),
    });
    let input = PostInput {
        content,
        media_keys: media,
        targets,
        utm,
        scheduled_at: at,
        // Nháp đi hàng đợi thì giờ để trống; bài hẹn nhận khung ở bước sau.
        use_queue: mode == ImportMode::Drafts && queue,
        source: None,
    };
    Item {
        plan,
        input,
        norm,
        queue,
    }
}

/// Kiểm toàn bộ các dòng (kiểu preview: gom lỗi theo dòng) + băm. Không ghi gì, không giữ khung hàng đợi.
async fn plan_rows<P: PostsPort, D: DraftsPort, Q: QueuePort>(
    db_: &TenantDb,
    ports: &ImportPorts<'_, P, D, Q>,
    user_id: i32,
    rows: &[ImportRowInput],
    mode: ImportMode,
    now: DateTime<Utc>,
) -> Result<(ImportPlan, Vec<Item>), AppError> {
    if rows.is_empty() {
        return Err(bad("Chưa có dòng nào để nhập."));
    }
    if rows.len() > IMPORT_MAX_ROWS {
        return Err(bad(format!("Tối đa {IMPORT_MAX_ROWS} dòng mỗi lần nhập.")));
    }
    let now_ms = now.timestamp_millis();
    let cx = load_ctx(db_, rows).await?;
    let mut items: Vec<Item> = rows.iter().map(|r| plan_row(r, mode, now_ms, &cx)).collect();

    // Hàng đợi (chỉ bài hẹn): xin MỘT lần đủ số khung cho mọi dòng hợp lệ, gán theo thứ tự dòng ⇒ hai dòng không bao giờ chung khung.
    if mode == ImportMode::Schedule {
        let wanting: Vec<usize> = items
            .iter()
            .enumerate()
            .filter(|(_, i)| i.queue && i.plan.errors.is_empty())
            .map(|(n, _)| n)
            .collect();
        if !wanting.is_empty() {
            let slots = ports.queue.next_free(wanting.len()).await?;
            for (n, idx) in wanting.into_iter().enumerate() {
                let it = &mut items[idx];
                match slots.get(n) {
                    None => it.plan.errors.push(
                        if slots.is_empty() {
                            NO_QUEUE_SLOTS
                        } else {
                            "Không đủ khung trống hàng đợi cho dòng này."
                        }
                        .to_owned(),
                    ),
                    Some(slot) => {
                        it.input.scheduled_at = Some(*slot);
                        it.plan.preview.scheduled_at = Some(js_iso_string(*slot));
                    }
                }
            }
        }
    }

    // Kiểm đầy đủ như lúc tạo (tuần tự, tránh dồn tải kho tệp).
    for it in &mut items {
        if it.plan.errors.is_empty() {
            let checked = match mode {
                ImportMode::Drafts => ports.drafts.check(user_id, &it.input).await,
                ImportMode::Schedule => match ports.posts.validate(user_id, &it.input).await {
                    Ok(v) if v.scheduled_at.is_none() => {
                        Err(HttpError::bad_request("Giờ hẹn đã qua — chọn giờ trong tương lai.").into())
                    }
                    Ok(_) => Ok(()),
                    Err(e) => Err(e),
                },
            };
            if let Err(e) = checked {
                it.plan.errors.push(row_message(&e));
            }
        }
        it.plan.ok = it.plan.errors.is_empty();
        if let Some(o) = it.norm.as_object_mut() {
            o.insert("ok".to_owned(), Value::Bool(it.plan.ok));
        }
    }

    // Băm cả khung hàng đợi đã gán: khung đổi (bị chiếm / đã qua) ⇒ mã khác ⇒ nhập bị từ chối, người dùng kiểm lại thấy giờ mới.
    let hashed: Vec<Value> = items
        .iter()
        .map(|i| {
            if i.queue {
                let mut v = i.norm.clone();
                let slot = if mode == ImportMode::Schedule {
                    i.input.scheduled_at.map(js_iso_string)
                } else {
                    None
                };
                if let Some(o) = v.as_object_mut() {
                    o.insert("slot".to_owned(), slot.map_or(Value::Null, Value::String));
                }
                v
            } else {
                i.norm.clone()
            }
        })
        .collect();
    let body = serde_json::to_vec(&json!({ "mode": mode, "rows": hashed })).map_err(AppError::internal)?;
    let plan_hash: String = Sha256::digest(&body).iter().map(|b| format!("{b:02x}")).collect();
    let plans: Vec<RowPlan> = items.iter().map(|i| i.plan.clone()).collect();
    let ok = plans.iter().filter(|p| p.ok).count();
    let plan = ImportPlan {
        mode,
        plan_hash,
        total: plans.len(),
        ok_count: ok,
        error_count: plans.len() - ok,
        rows: plans,
        unknown_columns: None,
    };
    Ok((plan, items))
}

/// `POST /social/posts/import/plan` ⇒ `{ data }`: kiểm CSV, không ghi gì.
pub async fn plan<P: PostsPort, D: DraftsPort, Q: QueuePort>(
    db_: &TenantDb,
    ports: &ImportPorts<'_, P, D, Q>,
    user_id: i32,
    csv: &str,
    mode: ImportMode,
    now: DateTime<Utc>,
) -> Result<ImportPlan, AppError> {
    let parsed = parse_csv(csv)?;
    let (mut plan, _) = plan_rows(db_, ports, user_id, &parsed.rows, mode, now).await?;
    if !parsed.unknown_columns.is_empty() {
        plan.unknown_columns = Some(parsed.unknown_columns);
    }
    Ok(plan)
}

/// Kiểm danh sách dòng có cấu trúc (MCP), không ghi gì.
pub async fn plan_structured<P: PostsPort, D: DraftsPort, Q: QueuePort>(
    db_: &TenantDb,
    ports: &ImportPorts<'_, P, D, Q>,
    user_id: i32,
    rows: &[StructuredRow],
    mode: ImportMode,
    now: DateTime<Utc>,
) -> Result<ImportPlan, AppError> {
    Ok(plan_rows(db_, ports, user_id, &rows_from_structured(rows), mode, now)
        .await?
        .0)
}

/// `POST /social/posts/import` ⇒ `{ ... }`: nhập CSV, kiểm lại, khác bản người dùng đã xem (`plan_hash`) ⇒ 409.
pub async fn import_csv<P: PostsPort, D: DraftsPort, Q: QueuePort>(
    db_: &TenantDb,
    ports: &ImportPorts<'_, P, D, Q>,
    user_id: i32,
    csv: &str,
    mode: ImportMode,
    plan_hash: &str,
    now: DateTime<Utc>,
) -> Result<ImportResult, AppError> {
    let parsed = parse_csv(csv)?;
    import_rows(db_, ports, user_id, &parsed.rows, mode, plan_hash, "csv", now).await
}

/// Nhập danh sách dòng (CSV hoặc MCP; `source` là `csv` | `mcp`). Từng dòng độc lập, theo thứ tự: một dòng hỏng không kéo
/// theo dòng khác.
#[allow(clippy::too_many_arguments)]
pub async fn import_rows<P: PostsPort, D: DraftsPort, Q: QueuePort>(
    db_: &TenantDb,
    ports: &ImportPorts<'_, P, D, Q>,
    user_id: i32,
    rows: &[ImportRowInput],
    mode: ImportMode,
    plan_hash: &str,
    source: &str,
    now: DateTime<Utc>,
) -> Result<ImportResult, AppError> {
    let (plan, items) = plan_rows(db_, ports, user_id, rows, mode, now).await?;
    if plan.plan_hash != plan_hash {
        return Err(HttpError::conflict(
            "Dữ liệu đã đổi so với bản đã kiểm tra (dòng, kênh, tệp hoặc trạng thái) — bấm \"Kiểm tra\" lại rồi nhập.",
        )
        .into());
    }
    let mut out = ImportResult {
        mode,
        created: Vec::new(),
        skipped: Vec::new(),
    };
    for it in items {
        let row = it.plan.row;
        if !it.plan.ok {
            out.skipped.push(Skipped {
                row,
                errors: it.plan.errors,
            });
            continue;
        }
        // Khoá chống lặp theo (lượt kiểm tra + dòng): gửi lại cùng lượt nhập (timeout, hai tab) không tạo bài lần hai.
        let dedupe = format!("{source}-import:{}:{row}", head(&plan.plan_hash, 16));
        let made: Result<i32, AppError> = match mode {
            ImportMode::Drafts => ports.drafts.create(user_id, &it.input, source, &dedupe).await,
            ImportMode::Schedule => {
                // Không bao giờ để `create` đăng ngay vì giờ hẹn đã trôi qua trong lúc nhập.
                let lead = it
                    .input
                    .scheduled_at
                    .map(|t| t.timestamp_millis() - Utc::now().timestamp_millis());
                match lead {
                    Some(l) if l >= IMPORT_MIN_LEAD_MS => {
                        let post = PostInput {
                            source: Some(source.to_owned()),
                            ..it.input.clone()
                        };
                        match ports.posts.create(user_id, &post, &dedupe, None).await {
                            Ok(id) => Ok(id),
                            Err(CreateFailure::Failed(e)) => Err(e),
                            Err(CreateFailure::Changed) => Err(AppError::internal("bài nhập bị huỷ không rõ lý do")),
                        }
                    }
                    _ => Err(bad("Giờ hẹn đã tới trong lúc nhập — kiểm tra lại với giờ mới.")),
                }
            }
        };
        match made {
            Ok(id) => out.created.push(Created { row, id }),
            Err(e) => {
                tracing::warn!("Nhập dòng {row}: {e} (mã {:?})", status_of(&e));
                out.skipped.push(Skipped {
                    row,
                    errors: vec![row_message(&e)],
                });
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cx() -> Ctx {
        let accounts = vec![
            Acct {
                id: 1,
                name: "Quán A".into(),
                network: "facebook".into(),
                status: "active".into(),
            },
            Acct {
                id: 2,
                name: "Quán B".into(),
                network: "facebook".into(),
                status: "reauth".into(),
            },
            Acct {
                id: 3,
                name: "Trùng".into(),
                network: "facebook".into(),
                status: "active".into(),
            },
            Acct {
                id: 4,
                name: "trùng".into(),
                network: "facebook".into(),
                status: "active".into(),
            },
            Acct {
                id: 5,
                name: "7".into(),
                network: "facebook".into(),
                status: "active".into(),
            },
            Acct {
                id: 7,
                name: "Số bảy".into(),
                network: "facebook".into(),
                status: "active".into(),
            },
        ];
        let mut by_id = HashMap::new();
        let mut by_name: HashMap<String, Vec<usize>> = HashMap::new();
        let mut by_lower: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, a) in accounts.iter().enumerate() {
            by_id.insert(a.id, i);
            by_name.entry(a.name.clone()).or_default().push(i);
            by_lower.entry(a.name.to_lowercase()).or_default().push(i);
        }
        let mut by_asset_name = HashMap::new();
        by_asset_name.insert("a.png".to_owned(), vec!["social/k2".to_owned(), "social/k1".to_owned()]);
        Ctx {
            accounts,
            by_id,
            by_name,
            by_lower,
            keys: ["social/k1".to_owned(), "social/k2".to_owned()].into_iter().collect(),
            by_asset_name,
        }
    }

    fn row(f: impl FnOnce(&mut ImportRowInput)) -> ImportRowInput {
        let mut r = ImportRowInput {
            row: 2,
            content: Some("Xin chào".into()),
            ..ImportRowInput::default()
        };
        f(&mut r);
        r
    }

    const NOW: i64 = 1_800_000_000_000;

    fn at(offset_ms: i64) -> String {
        js_iso_string(DateTime::from_timestamp_millis(NOW + offset_ms).unwrap())
    }

    #[test]
    fn dong_hop_le_bai_hen() {
        let r = row(|r| {
            r.channels = vec!["Quán A".into(), "1".into()];
            r.scheduled_at = Some(at(2 * 3_600_000));
            r.first_comment = Some("bình luận".into());
            r.media = vec!["a.png".into(), "social/k1".into()];
        });
        let it = plan_row(&r, ImportMode::Schedule, NOW, &cx());
        assert!(it.plan.errors.is_empty(), "{:?}", it.plan.errors);
        assert_eq!(it.plan.preview.channels.len(), 1);
        assert_eq!(
            it.plan.warnings,
            vec![
                "Kênh \"Quán A\" ghi nhiều lần — chỉ tính một.",
                "Có 2 tệp tên \"a.png\" — dùng tệp mới nhất."
            ]
        );
        // Tệp trùng tên lấy tệp mới nhất (đứng đầu danh sách), bỏ trùng.
        assert_eq!(it.input.media_keys, vec!["social/k2", "social/k1"]);
        let opts = it.input.targets[0].options.as_ref().unwrap();
        assert_eq!(opts["first_comment"], "bình luận");
        assert!(!it.input.use_queue);
    }

    #[test]
    fn kenh_mo_ho() {
        let msgs = |ch: &str| {
            let r = row(|r| {
                r.channels = vec![ch.into()];
                r.scheduled_at = Some(at(3_600_000));
            });
            plan_row(&r, ImportMode::Schedule, NOW, &cx()).plan.errors
        };
        // "7" vừa là id kênh 7 vừa là tên kênh 5.
        assert_eq!(
            msgs("7"),
            vec!["\"7\" vừa là id kênh vừa là tên một kênh khác — ghi rõ tên hoặc id."]
        );
        assert_eq!(
            msgs("TRÙNG"),
            vec!["Tên kênh \"TRÙNG\" trùng nhiều kênh — dùng id kênh."]
        );
        assert_eq!(msgs("Không có"), vec!["Không tìm thấy kênh \"Không có\"."]);
        assert!(
            msgs("quán a").is_empty(),
            "tên không phân biệt hoa thường khi không trùng"
        );
        assert!(msgs("99999999999").iter().any(|m| m.starts_with("Không tìm thấy kênh")));
    }

    #[test]
    fn gio_bai_hen() {
        let errs = |s: Option<String>, queue: bool| {
            let r = row(|r| {
                r.channels = vec!["1".into()];
                r.scheduled_at = s;
                r.use_queue = queue;
            });
            plan_row(&r, ImportMode::Schedule, NOW, &cx()).plan.errors
        };
        assert_eq!(errs(None, false), vec!["Cần giờ đăng hoặc 'hàng đợi'."]);
        assert!(errs(None, true).is_empty());
        assert_eq!(
            errs(Some(at(30_000)), false),
            vec!["Giờ hẹn phải sau bây giờ ít nhất 1 phút."]
        );
        assert_eq!(
            errs(Some(at(91 * 86_400_000)), false),
            vec!["Chỉ hẹn trước tối đa 90 ngày."]
        );
        assert_eq!(
            errs(Some(at(3_600_000)), true),
            vec!["Chỉ chọn một: giờ cụ thể hoặc 'hàng đợi'."]
        );
        assert!(errs(Some("mai 9h".into()), false)[0].contains("không đúng dạng"));
    }

    #[test]
    fn nhap_phai_co_kenh_va_noi_dung() {
        let r = ImportRowInput {
            row: 3,
            ..ImportRowInput::default()
        };
        let it = plan_row(&r, ImportMode::Schedule, NOW, &cx());
        assert!(it.plan.errors.contains(&"Cần ít nhất một kênh.".to_owned()));
        assert!(it.plan.errors.contains(&"Cần nội dung hoặc ảnh/video.".to_owned()));
        // Nháp: không bắt kênh/giờ; kênh cần liên kết lại chỉ cảnh báo.
        let d = row(|r| r.channels = vec!["Quán B".into()]);
        let it = plan_row(&d, ImportMode::Drafts, NOW, &cx());
        assert!(it.plan.errors.is_empty());
        assert_eq!(
            it.plan.warnings,
            vec!["Kênh \"Quán B\" cần liên kết lại trước khi đăng."]
        );
    }

    #[test]
    fn tep_khong_co_trong_thu_vien() {
        let r = row(|r| {
            r.channels = vec!["1".into()];
            r.scheduled_at = Some(at(3_600_000));
            r.media = vec!["la.png".into(), "social/chua-co".into()];
        });
        let it = plan_row(&r, ImportMode::Schedule, NOW, &cx());
        assert_eq!(
            it.plan.errors,
            vec!["Không thấy tệp \"la.png\" trong thư viện (khoá hoặc tên tệp gốc)."]
        );
        // Khoá dạng social/… chưa có trong danh sách vẫn nhận (cổng kiểm tệp sẽ báo nếu không có thật).
        assert_eq!(it.input.media_keys, vec!["social/chua-co"]);
    }

    #[test]
    fn utm_va_binh_luan_dau() {
        let r = row(|r| {
            r.channels = vec!["1".into()];
            r.scheduled_at = Some(at(3_600_000));
            r.utm_campaign = Some("thu 10".into());
        });
        let it = plan_row(&r, ImportMode::Schedule, NOW, &cx());
        assert_eq!(it.input.utm.as_ref().unwrap().campaign, "thu-10");
        for (bad_utm, want) in [
            (
                "a&b",
                "UTM: tên chiến dịch (campaign) không được chứa các ký tự & # = ? % /.",
            ),
            (
                "x".repeat(101).leak() as &str,
                "UTM: tên chiến dịch (campaign) tối đa 100 ký tự.",
            ),
        ] {
            let r = row(|r| {
                r.channels = vec!["1".into()];
                r.scheduled_at = Some(at(3_600_000));
                r.utm_campaign = Some(bad_utm.into());
            });
            assert_eq!(plan_row(&r, ImportMode::Schedule, NOW, &cx()).plan.errors, vec![want]);
        }
        let r = row(|r| {
            r.channels = vec!["1".into()];
            r.scheduled_at = Some(at(3_600_000));
            r.first_comment = Some("c".into());
        });
        assert!(plan_row(&r, ImportMode::Schedule, NOW, &cx()).plan.warnings.is_empty());
    }

    #[test]
    fn hang_doi_nhap_nhap_dung_khung() {
        let r = row(|r| {
            r.channels = vec!["1".into()];
            r.use_queue = true;
        });
        let it = plan_row(&r, ImportMode::Schedule, NOW, &cx());
        assert!(it.queue && it.plan.errors.is_empty());
        assert_eq!(it.input.scheduled_at, None);
        let d = plan_row(&r, ImportMode::Drafts, NOW, &cx());
        assert!(d.input.use_queue);
    }

    #[test]
    fn dong_cau_truc_ve_dang_chung() {
        let rows = rows_from_structured(&[
            StructuredRow {
                content: Some("  hi ".into()),
                account_ids: vec![1, 2],
                scheduled_at: Some("  ".into()),
                use_queue: true,
                media_keys: vec![" k ".into(), String::new()],
                ..StructuredRow::default()
            },
            StructuredRow::default(),
        ]);
        assert_eq!(rows[0].row, 1);
        assert_eq!(rows[0].content.as_deref(), Some("hi"));
        assert_eq!(rows[0].channels, vec!["1", "2"]);
        assert_eq!(rows[0].scheduled_at, None);
        assert!(rows[0].use_queue);
        assert_eq!(rows[0].media, vec!["k"]);
        assert_eq!(rows[1].row, 2);
    }

    #[test]
    fn trich_doan_va_loi_dong() {
        assert_eq!(excerpt("a  b\n c"), "a b c");
        assert_eq!(excerpt(&"x".repeat(100)).chars().count(), 80);
        let e: AppError = HttpError::bad_request("Sai kênh").into();
        assert_eq!(row_message(&e), "Sai kênh");
        assert_eq!(row_message(&AppError::internal("lộ bí mật")), GENERIC_ROW_ERROR);
        let e500: AppError = HttpError::new(500, "chi tiết").into();
        assert_eq!(row_message(&e500), GENERIC_ROW_ERROR);
    }

    #[test]
    fn che_do_serialize() {
        assert_eq!(serde_json::to_value(ImportMode::Drafts).unwrap(), json!("drafts"));
        assert_eq!(serde_json::to_value(ImportMode::Schedule).unwrap(), json!("schedule"));
    }
}
