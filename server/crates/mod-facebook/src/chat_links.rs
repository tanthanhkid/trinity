//! Link/QR mở chat Messenger kèm nguồn khách (M50), chuyển từ `facebook-chat-links.service.ts`, `ingestReferral` của
//! `facebook-messenger.service.ts` và `go/:code` của `facebook-public.controller.ts`.
//!
//! Khách mở link công khai `/api/v1/facebook/go/:code` ⇒ Trinity đếm lượt mở rồi chuyển sang `m.me/<page>?ref=<mã>`; Meta gửi lại `ref`
//! trong webhook ⇒ [`FacebookIngest::ingest_referral`] gắn link vào hội thoại (lần đầu), tạo khách với nguồn của link và ghi lịch sử.
//!
//! Hàm dịch vụ nhận `&mut PgConnection` (một kết nối đã gắn công ty, người gọi trả lại ngay sau khi xong) như `pages`; riêng
//! `ingest_referral` tự lấy kết nối từng bước và không giữ kết nối khi gọi Graph.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use mod_public_api::service::{NewContact, create_contact_in_tx};
use serde_json::{Value, json};
use sqlx::{PgConnection, Postgres, QueryBuilder};
use trinity_db::CompanyRef;
use trinity_db::models::{FacebookChatLink, FacebookPage};
use trinity_db::types::Timestamp;
use trinity_integrations::webhooks::inbound::token::with_company_hint;
use trinity_kernel::error::{AppError, HttpError};

use crate::config::{Env, encode_uri_component, load_facebook_config};
use crate::dto;
use crate::graph::utf16_prefix;
use crate::ingest::{FacebookIngest, db, platform_db, str_of};
use crate::messenger::{owner_for, placeholder_name};
use crate::pages;

/// Chữ thường + số, bỏ ký tự dễ nhầm (0/o, 1/l/i) để đọc từ ấn phẩm không nhầm.
pub const CODE_ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
/// Độ dài mã trong link.
pub const CODE_LEN: usize = 8;
/// Số lần thử mã khác khi trùng (rất hiếm).
const MAX_CODE_TRIES: usize = 5;
/// Khách tạo từ Messenger trong khoảng này trước khi `ref` tới (tin đầu tới trước referral) vẫn được đổi sang nguồn của link.
const LATE_REFERRAL_SECS: f64 = 600.0;

const LINK_COLS: &str =
    "id, code, name, page_id, source_id, is_active, clicks, chats, created_by, created_at, updated_at";
const NAME_MAX: usize = 120;
const PAGE_ID_MAX: usize = 40;

/// Mã link từ chuỗi hex (`replace(gen_random_uuid()::text, '-', '')`): mỗi cặp hex là một byte, `byte % 31` chọn chữ như
/// `ALPHABET[x % ALPHABET.length]` của bản TS.
pub fn code_from_hex(hex: &str, len: usize) -> String {
    hex.as_bytes()
        .chunks(2)
        .filter_map(|p| std::str::from_utf8(p).ok().and_then(|s| u8::from_str_radix(s, 16).ok()))
        .take(len)
        .map(|b| char::from(CODE_ALPHABET[usize::from(b) % CODE_ALPHABET.len()]))
        .collect()
}

/// Link mở thẳng Messenger của Page kèm mã nguồn: Meta gửi lại `ref` trong webhook khi khách vào chat.
pub fn messenger_url(page_id: &str, code: &str) -> String {
    format!(
        "https://m.me/{}?ref={}",
        encode_uri_component(page_id),
        encode_uri_component(code)
    )
}

/// Link Messenger không kèm nguồn (link đã tắt).
pub fn messenger_plain_url(page_id: &str) -> String {
    format!("https://m.me/{}", encode_uri_component(page_id))
}

/// Mã `ref` của link mở chat trong một sự kiện Messenger (ở bất kỳ chỗ nào Meta đặt nó); không có ⇒ `None`.
pub fn referral_ref(ev: &Value) -> Option<String> {
    if ev.pointer("/message/is_echo") == Some(&Value::Bool(true)) {
        return None;
    }
    // `a ?? b ?? c`: lấy giá trị đầu tiên không null.
    let first = [
        ev.pointer("/referral/ref"),
        ev.pointer("/postback/referral/ref"),
        ev.pointer("/message/referral/ref"),
    ]
    .into_iter()
    .flatten()
    .find(|v| !v.is_null())?;
    let s = first
        .as_str()
        .map(trinity_kernel::vi::trim_js)
        .filter(|s| !s.is_empty())?;
    Some(utf16_prefix(s, 32))
}

/// Cách dựng link đưa ra ngoài: URL gốc công khai và gợi ý công ty (`?cid=`) khi nhiều công ty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkUrls {
    pub base_url: Option<String>,
    pub multi_tenant: bool,
    pub company_id: i32,
}

impl LinkUrls {
    pub fn from_env(env: &Env, multi_tenant: bool, company: CompanyRef) -> Self {
        Self {
            base_url: load_facebook_config(env).base_url,
            multi_tenant,
            company_id: company.id(),
        }
    }

    /// Link đưa ra ngoài (in QR, gắn web): qua Trinity để đếm lượt mở. `None` khi chưa đặt địa chỉ công khai.
    pub fn go_url(&self, code: &str) -> Option<String> {
        let base = self.base_url.as_deref()?;
        Some(with_company_hint(
            &format!("{base}/api/v1/facebook/go/{code}"),
            self.multi_tenant,
            self.company_id,
        ))
    }
}

/// Body `POST/PATCH /facebook/chat-links` (`ChatLinkDto`) đã kiểm. Dựng bằng [`ChatLinkInput::from_json`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChatLinkInput {
    pub name: Option<String>,
    pub page_id: Option<String>,
    /// `Some(None)` = đặt về nguồn mặc định của Page.
    pub source_id: Option<Option<i32>>,
    pub is_active: Option<bool>,
}

impl ChatLinkInput {
    /// `name`/`page_id`: `@IsOptional() @IsString() @MaxLength`; `source_id`: `@ValidateIf(v != null) @IsInt()`; `is_active`:
    /// `@IsOptional() @IsBoolean()`. Trường lạ ⇒ 400.
    pub fn from_json(v: &Value) -> Result<Self, HttpError> {
        let o = dto::object(v)?;
        let mut e = Vec::new();
        dto::unknown(o, &["name", "page_id", "source_id", "is_active"], &mut e);
        let name = dto::opt_string(o, "name", NAME_MAX, &mut e);
        let page_id = dto::opt_string(o, "page_id", PAGE_ID_MAX, &mut e);
        let source_id = dto::nullable_int(o, "source_id", &mut e);
        let is_active = dto::opt_bool(o, "is_active", &mut e);
        dto::finish(e)?;
        Ok(Self {
            name,
            page_id,
            source_id,
            is_active,
        })
    }
}

fn iso(t: &Timestamp) -> String {
    trinity_kernel::vn_time::js_iso_string(t.0)
}

fn bad(msg: &str) -> AppError {
    HttpError::bad_request(msg).into()
}

async fn find(conn: &mut PgConnection, id: i32) -> Result<FacebookChatLink, AppError> {
    sqlx::query_as::<_, FacebookChatLink>(sqlx::AssertSqlSafe(format!(
        "SELECT {LINK_COLS} FROM facebook_chat_links WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(db)?
    .ok_or_else(|| HttpError::not_found("Không tìm thấy link").into())
}

/// Tên đã cắt gọn (tối đa 120 ký tự UTF-16); rỗng ⇒ 400.
fn clean_name(raw: &str) -> Result<String, AppError> {
    let name = trinity_kernel::vi::trim_js(raw);
    if name.is_empty() {
        return Err(bad("Đặt tên cho link (vd \"Tờ rơi quán\", \"QR bàn 5\")"));
    }
    Ok(utf16_prefix(name, NAME_MAX))
}

async fn assert_page(conn: &mut PgConnection, page_id: Option<&str>) -> Result<String, AppError> {
    let page_id = page_id.unwrap_or("");
    let found: bool = if page_id.is_empty() {
        false
    } else {
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM facebook_pages WHERE page_id = $1)")
            .bind(page_id)
            .fetch_one(conn)
            .await
            .map_err(db)?
    };
    if found {
        Ok(page_id.to_owned())
    } else {
        Err(bad("Chọn Fanpage đã kết nối"))
    }
}

async fn assert_source(conn: &mut PgConnection, source_id: i32) -> Result<(), AppError> {
    let ok: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM setting_options WHERE id = $1 AND group_key = 'contact_source')",
    )
    .bind(source_id)
    .fetch_one(conn)
    .await
    .map_err(db)?;
    if ok {
        Ok(())
    } else {
        Err(bad("Nguồn khách không hợp lệ"))
    }
}

/// Thêm `url`, `messenger_url`, `page_name`, `source_label` cho từng dòng.
async fn views(conn: &mut PgConnection, rows: &[FacebookChatLink], urls: &LinkUrls) -> Result<Vec<Value>, AppError> {
    let page_ids: Vec<String> = rows.iter().map(|r| r.page_id.clone()).collect();
    let source_ids: Vec<i32> = rows.iter().filter_map(|r| r.source_id).collect();
    let pages: Vec<(String, String)> =
        sqlx::query_as("SELECT page_id, name FROM facebook_pages WHERE page_id = ANY($1)")
            .bind(&page_ids)
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?;
    let sources: Vec<(i32, String)> = sqlx::query_as("SELECT id, label FROM setting_options WHERE id = ANY($1)")
        .bind(&source_ids)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
    let page_name: HashMap<String, String> = pages.into_iter().collect();
    let source_label: HashMap<i32, String> = sources.into_iter().collect();
    Ok(rows
        .iter()
        .map(|r| {
            json!({
                "id": r.id, "code": r.code, "name": r.name, "page_id": r.page_id, "source_id": r.source_id,
                "is_active": r.is_active, "clicks": r.clicks, "chats": r.chats, "created_by": r.created_by,
                "created_at": iso(&r.created_at), "updated_at": iso(&r.updated_at),
                "url": urls.go_url(&r.code),
                "messenger_url": messenger_url(&r.page_id, &r.code),
                "page_name": page_name.get(&r.page_id),
                "source_label": r.source_id.and_then(|s| source_label.get(&s)),
            })
        })
        .collect())
}

async fn one_view(conn: &mut PgConnection, row: FacebookChatLink, urls: &LinkUrls) -> Result<Value, AppError> {
    let mut v = views(conn, std::slice::from_ref(&row), urls).await?;
    v.pop().ok_or_else(|| AppError::internal("link không có view"))
}

/// `GET /facebook/chat-links` ⇒ `{ data }`: mới nhất trước.
pub async fn list(conn: &mut PgConnection, urls: &LinkUrls) -> Result<Value, AppError> {
    let rows = sqlx::query_as::<_, FacebookChatLink>(sqlx::AssertSqlSafe(format!(
        "SELECT {LINK_COLS} FROM facebook_chat_links ORDER BY id DESC"
    )))
    .fetch_all(&mut *conn)
    .await
    .map_err(db)?;
    Ok(json!({ "data": views(conn, &rows, urls).await? }))
}

/// `POST /facebook/chat-links` (201): mã ngẫu nhiên 8 ký tự, thử lại tối đa 5 lần khi trùng mã.
pub async fn create(
    conn: &mut PgConnection,
    input: &ChatLinkInput,
    user_id: i32,
    urls: &LinkUrls,
) -> Result<Value, AppError> {
    let name = clean_name(input.name.as_deref().unwrap_or(""))?;
    let page_id = assert_page(&mut *conn, input.page_id.as_deref()).await?;
    let source_id = input.source_id.flatten();
    if let Some(s) = source_id {
        assert_source(&mut *conn, s).await?;
    }
    for _ in 0..MAX_CODE_TRIES {
        let hex: String = sqlx::query_scalar("SELECT replace(gen_random_uuid()::text, '-', '')")
            .fetch_one(&mut *conn)
            .await
            .map_err(db)?;
        let row = sqlx::query_as::<_, FacebookChatLink>(sqlx::AssertSqlSafe(format!(
            "INSERT INTO facebook_chat_links (code, name, page_id, source_id, is_active, created_by, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, now()) ON CONFLICT (code) DO NOTHING RETURNING {LINK_COLS}"
        )))
        .bind(code_from_hex(&hex, CODE_LEN))
        .bind(&name)
        .bind(&page_id)
        .bind(source_id)
        .bind(input.is_active.unwrap_or(true))
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
        if let Some(row) = row {
            return one_view(conn, row, urls).await;
        }
    }
    Err(AppError::internal("không sinh được mã link duy nhất"))
}

/// `PATCH /facebook/chat-links/:id`: đổi tên / nguồn / bật tắt (không đổi Page: `page_id` trong body bị bỏ qua).
pub async fn update(
    conn: &mut PgConnection,
    id: i32,
    input: &ChatLinkInput,
    urls: &LinkUrls,
) -> Result<Value, AppError> {
    find(&mut *conn, id).await?;
    let name = match input.name.as_deref() {
        Some(n) => Some(clean_name(n)?),
        None => None,
    };
    if let Some(Some(s)) = input.source_id {
        assert_source(&mut *conn, s).await?;
    }
    let mut qb: QueryBuilder<Postgres> = QueryBuilder::new("UPDATE facebook_chat_links SET updated_at = now()");
    if let Some(n) = name {
        qb.push(", name = ").push_bind(n);
    }
    if let Some(s) = input.source_id {
        qb.push(", source_id = ").push_bind(s);
    }
    if let Some(a) = input.is_active {
        qb.push(", is_active = ").push_bind(a);
    }
    qb.push(" WHERE id = ")
        .push_bind(id)
        .push(format!(" RETURNING {LINK_COLS}"));
    let row = qb
        .build_query_as::<FacebookChatLink>()
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
    one_view(conn, row, urls).await
}

/// `DELETE /facebook/chat-links/:id` (204): hội thoại đã vào qua link giữ nguyên nguồn nhưng không còn gắn link (một câu lệnh).
pub async fn remove(conn: &mut PgConnection, id: i32) -> Result<(), AppError> {
    find(&mut *conn, id).await?;
    sqlx::query(
        "WITH c AS (UPDATE facebook_conversations SET entry_link_id = NULL WHERE entry_link_id = $1) \
         DELETE FROM facebook_chat_links WHERE id = $1",
    )
    .bind(id)
    .execute(conn)
    .await
    .map_err(db)?;
    Ok(())
}

/// `GET /facebook/go/:code` (công khai): đếm lượt rồi trả đích Messenger (người gọi trả 302, `cache-control: no-store`). Không có
/// link ⇒ `None` (404). Link tắt ⇒ vẫn mở Messenger của Page nhưng không gắn nguồn, không đếm. Đếm lượt lỗi chỉ ghi log, không
/// chặn khách vào chat.
pub async fn open(conn: &mut PgConnection, code: &str) -> Result<Option<String>, AppError> {
    let code = utf16_prefix(code, 32);
    let link: Option<(i32, String, String, bool)> =
        sqlx::query_as("SELECT id, code, page_id, is_active FROM facebook_chat_links WHERE code = $1")
            .bind(&code)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
    let Some((id, code, page_id, active)) = link else {
        return Ok(None);
    };
    if !active {
        return Ok(Some(messenger_plain_url(&page_id)));
    }
    let counted = sqlx::query("UPDATE facebook_chat_links SET clicks = clicks + 1, updated_at = now() WHERE id = $1")
        .bind(id)
        .execute(conn)
        .await;
    if let Err(e) = counted {
        tracing::warn!("Không đếm được lượt mở link chat {id}: {e}");
    }
    Ok(Some(messenger_url(&page_id, &code)))
}

/// `ev.timestamp ? new Date(ev.timestamp) : new Date()`.
fn event_time(ev: &Value) -> DateTime<Utc> {
    ev.get("timestamp")
        .and_then(|t| t.as_i64().or_else(|| t.as_f64().map(|f| f as i64)))
        .filter(|m| *m != 0)
        .and_then(DateTime::from_timestamp_millis)
        .unwrap_or_else(Utc::now)
}

impl FacebookIngest {
    /// Khách vào chat qua link/QR (`ref` = mã link): gắn link vào hội thoại (lần đầu: "nguồn" là link đầu tiên), tạo khách với nguồn
    /// của link (chưa có khách) và ghi lịch sử. Meta gửi lại webhook ⇒ chỉ xử lý khi hội thoại CHƯA gắn link (idempotent: giành
    /// hội thoại bằng `UPDATE … WHERE entry_link_id IS NULL`). Chạy TRƯỚC tin nhắn cùng sự kiện để khách mới mang nguồn của link.
    pub async fn ingest_referral(&self, company: CompanyRef, page_id: &str, ev: &Value) -> Result<bool, AppError> {
        let Some(code) = referral_ref(ev) else {
            return Ok(false);
        };
        let Some(psid) = str_of(ev.pointer("/sender/id")) else {
            return Ok(false);
        };
        // Bước 1: link, Page + token, hội thoại hiện có (kết nối trả lại ngay, không giữ khi gọi Graph).
        let (link, page, token, existing) = {
            let mut c = self.acquire(company).await?;
            let link = sqlx::query_as::<_, FacebookChatLink>(sqlx::AssertSqlSafe(format!(
                "SELECT {LINK_COLS} FROM facebook_chat_links WHERE code = $1"
            )))
            .bind(&code)
            .fetch_optional(&mut *c)
            .await
            .map_err(db)?;
            let Some(link) = link.filter(|l| l.page_id == page_id && l.is_active) else {
                return Ok(false);
            };
            let Some((page, token)) = pages::active_page_with_token(&mut c, &self.env, page_id).await? else {
                return Ok(false);
            };
            let existing: Option<(Option<i32>, Option<String>)> = sqlx::query_as(
                "SELECT entry_link_id, customer_name FROM facebook_conversations WHERE page_id = $1 AND psid = $2",
            )
            .bind(page_id)
            .bind(&psid)
            .fetch_optional(&mut *c)
            .await
            .map_err(db)?;
            (link, page, token, existing)
        };
        if existing.as_ref().is_some_and(|(linked, _)| linked.is_some()) {
            return Ok(false);
        }
        // Bước 2: tên Facebook (HTTP, không giữ kết nối); hội thoại đã có thì không hỏi lại.
        let name: Option<String> = if existing.is_some() {
            None
        } else {
            let graph = (self.graph_for)(company);
            match graph.get_user_name(&psid, &token).await {
                Some(n) => Some(n),
                None => graph.get_conversation_name(page_id, &psid, &token).await,
            }
        };
        let source_id = link.source_id.unwrap_or(page.contact_source_id);
        // Bước 3: MỘT giao dịch.
        let mut tx = self
            .db
            .tenant(company)
            .await
            .map_err(platform_db)?
            .begin()
            .await
            .map_err(platform_db)?;
        let conv: (i32, Option<i32>, Option<String>) = sqlx::query_as(
            "INSERT INTO facebook_conversations (page_id, psid, customer_name, last_message_at) VALUES ($1, $2, $3, $4) \
             ON CONFLICT (page_id, psid) DO UPDATE SET page_id = facebook_conversations.page_id \
             RETURNING id, contact_id, customer_name",
        )
        .bind(page_id)
        .bind(&psid)
        .bind(name.as_deref())
        .bind(event_time(ev))
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        let (conv_id, conv_contact, conv_name) = conv;
        // Meta gửi lại / hai sự kiện cùng lúc: chỉ lượt giành được hội thoại chưa gắn link mới ghi tiếp.
        let claimed =
            sqlx::query("UPDATE facebook_conversations SET entry_link_id = $2 WHERE id = $1 AND entry_link_id IS NULL")
                .bind(conv_id)
                .bind(link.id)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
        if claimed.rows_affected() == 0 {
            return Ok(false);
        }
        sqlx::query("UPDATE facebook_chat_links SET chats = chats + 1, updated_at = now() WHERE id = $1")
            .bind(link.id)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let contact_id = match conv_contact {
            Some(cid) => {
                // Tin đầu tới trước referral ⇒ khách vừa tạo với nguồn mặc định của Page: đổi sang nguồn của link.
                if let Some(s) = link.source_id
                    && s != page.contact_source_id
                {
                    sqlx::query(
                        "UPDATE contacts SET source_id = $2 WHERE id = $1 AND source_id = $3 \
                         AND created_at >= now() - make_interval(secs => $4)",
                    )
                    .bind(cid)
                    .bind(s)
                    .bind(page.contact_source_id)
                    .bind(LATE_REFERRAL_SECS)
                    .execute(&mut *tx)
                    .await
                    .map_err(db)?;
                }
                Some(cid)
            }
            None => create_contact(&mut tx, &page, conv_id, &psid, conv_name.as_deref(), source_id).await?,
        };
        if let Some(cid) = contact_id {
            let description = utf16_prefix(
                &format!("Khách mở chat Page \"{}\" qua link \"{}\"", page.name, link.name),
                2000,
            );
            let details = json!({ "description": description, "source": "facebook_messenger" });
            let metadata = json!({
                "facebook_page_id": page_id, "psid": psid, "chat_link_id": link.id, "chat_link_code": link.code,
            });
            sqlx::query(
                "INSERT INTO activities (contact_id, action, details, metadata, created_by) \
                 VALUES ($1, 'note', $2::text::jsonb, $3::text::jsonb, NULL)",
            )
            .bind(cid)
            .bind(trinity_kernel::json::js_json(&details))
            .bind(trinity_kernel::json::js_json(&metadata))
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        }
        tx.commit().await.map_err(platform_db)?;
        Ok(true)
    }
}

/// Khách mới cho người vào qua link (không có SĐT): người nhận khách của Page, nghỉ việc thì người kết nối Page; cả hai không
/// còn hoạt động ⇒ không tạo. Dùng cùng khoá advisory với `messenger::link_contact` để hai đường không tạo trùng khách.
async fn create_contact(
    conn: &mut PgConnection,
    page: &FacebookPage,
    conv_id: i32,
    psid: &str,
    customer_name: Option<&str>,
    source_id: i32,
) -> Result<Option<i32>, AppError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext(current_schema() || '.fb_contact.' || $1 || ':' || $2))")
        .bind(&page.page_id)
        .bind(psid)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let Some(owner) = owner_for(&mut *conn, page).await? else {
        tracing::warn!(
            "Không tạo khách từ link chat (Page {}): người nhận khách và người kết nối Page đều không còn hoạt động",
            page.page_id
        );
        return Ok(None);
    };
    let name = customer_name.map_or_else(|| placeholder_name(psid), str::to_owned);
    let (id, _) = create_contact_in_tx(
        &mut *conn,
        &NewContact {
            phone: "",
            full_name: Some(&name),
            source_id: Some(source_id),
            email: None,
            job_title: None,
            reminder_notes: None,
            zalo_account: None,
            project_id: page.project_id,
        },
        &owner,
        "facebook_messenger",
    )
    .await?;
    sqlx::query("UPDATE facebook_conversations SET contact_id = $2 WHERE id = $1")
        .bind(conv_id)
        .bind(id)
        .execute(conn)
        .await
        .map_err(db)?;
    Ok(Some(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ma_link_tu_hex() {
        let c = code_from_hex("00ff10203040506070809000aabbccdd", CODE_LEN);
        assert_eq!(c.len(), 8);
        assert!(c.bytes().all(|b| CODE_ALPHABET.contains(&b)));
        // 0x00 % 31 = 0 ('a'); 0xff = 255, 255 % 31 = 7 ('h').
        assert!(c.starts_with("ah"));
        assert_eq!(code_from_hex("abcdef", 8).len(), 3, "thiếu hex thì ngắn hơn");
        assert!(!c.contains(['0', 'o', '1', 'l', 'i']));
    }

    #[test]
    fn link_messenger() {
        assert_eq!(messenger_url("123", "ab2c"), "https://m.me/123?ref=ab2c");
        assert_eq!(messenger_url("a b", "x&y"), "https://m.me/a%20b?ref=x%26y");
        assert_eq!(messenger_plain_url("123"), "https://m.me/123");
    }

    #[test]
    fn ref_o_moi_cho_meta_dat() {
        let r = |v: Value| referral_ref(&v);
        assert_eq!(r(json!({ "referral": { "ref": " abc " } })).as_deref(), Some("abc"));
        assert_eq!(
            r(json!({ "postback": { "referral": { "ref": "p1" } } })).as_deref(),
            Some("p1")
        );
        assert_eq!(
            r(json!({ "message": { "referral": { "ref": "m1" } } })).as_deref(),
            Some("m1")
        );
        // Echo của chính Page ⇒ không phải khách vào chat.
        assert_eq!(
            r(json!({ "message": { "is_echo": true, "referral": { "ref": "m1" } } })),
            None
        );
        assert_eq!(r(json!({ "referral": { "ref": "   " } })), None);
        assert_eq!(r(json!({ "referral": { "ref": 5 } })), None);
        assert_eq!(r(json!({})), None);
        let long = "x".repeat(40);
        assert_eq!(r(json!({ "referral": { "ref": long } })).unwrap().len(), 32);
    }

    #[test]
    fn link_cong_khai_theo_cong_ty() {
        let mut u = LinkUrls {
            base_url: Some("https://crm.example.com".to_owned()),
            multi_tenant: false,
            company_id: 5,
        };
        let plain = "https://crm.example.com/api/v1/facebook/go/abc";
        assert_eq!(u.go_url("abc").as_deref(), Some(plain));
        u.multi_tenant = true;
        assert_eq!(u.go_url("abc").unwrap(), format!("{plain}?cid=5"));
        u.company_id = 1;
        assert_eq!(u.go_url("abc").as_deref(), Some(plain));
        u.base_url = None;
        assert_eq!(u.go_url("abc"), None);
    }

    #[test]
    fn body_link() {
        let body = json!({ "name": "QR", "page_id": "1", "source_id": null, "is_active": false });
        let ok = ChatLinkInput::from_json(&body).unwrap();
        assert_eq!(ok.name.as_deref(), Some("QR"));
        assert_eq!(ok.source_id, Some(None));
        assert_eq!(ok.is_active, Some(false));
        assert_eq!(ChatLinkInput::from_json(&json!({})).unwrap(), ChatLinkInput::default());
        assert!(ChatLinkInput::from_json(&json!({ "source_id": "x" })).is_err());
        assert!(ChatLinkInput::from_json(&json!({ "source_id": 3_000_000_000_i64 })).is_err());
        assert!(ChatLinkInput::from_json(&json!({ "name": "x".repeat(121) })).is_err());
        assert!(ChatLinkInput::from_json(&json!({ "nope": 1 })).is_err());
        assert!(ChatLinkInput::from_json(&json!([])).is_err());
        // `name: null` coi như chuỗi rỗng ⇒ service trả 400 "Đặt tên cho link".
        let n = ChatLinkInput::from_json(&json!({ "name": null })).unwrap();
        assert!(clean_name(n.name.as_deref().unwrap()).is_err());
        assert_eq!(clean_name("  Tờ rơi  ").unwrap(), "Tờ rơi");
    }
}
