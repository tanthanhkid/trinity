//! Hội thoại và tin nhắn OA (`zalo-oa-threads.service.ts`). Ghi tin là MỘT giao dịch (tin + cập nhật hội thoại + outbox
//! `zalo_oa.message_received|sent`) và khử trùng theo `msg_id` (webhook gửi lại không phát sự kiện lần hai).

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::{Acquire, PgConnection, Postgres, QueryBuilder};
use trinity_db::models::{ZaloOaMessage, ZaloOaThread};
use trinity_db::outbox::publish_integration_event;
use trinity_db::pg_error::{app_error, db_error};
use trinity_db::types::{JsBigInt, JsonValue, Timestamp};
use trinity_kernel::error::{AppError, DbErrorKind, HttpError};
use trinity_kernel::phone::{detect_phones, normalize_phone};

use crate::config::to_zalo_phone;
use crate::contacts::{self, LinkInput};
use crate::utf16_prefix;

#[allow(clippy::needless_pass_by_value)]
fn db(e: sqlx::Error) -> AppError {
    app_error(&e)
}

const THREAD_COLS: &str = "id, oa_id, zalo_user_id, display_name, avatar_url, phone, contact_id, last_message_preview, last_message_at, last_inbound_at, unread_count, created_at, updated_at";
const MSG_COLS: &str = "id, thread_id, direction, kind, msg_id, text, payload, status, error, sent_by, created_at";
const PREVIEW_MAX: usize = 200;

/// Một tin cần ghi.
#[derive(Debug, Clone)]
pub struct RecordMessage<'a> {
    pub thread_id: i32,
    /// `in` | `out`.
    pub direction: &'static str,
    /// `text` | `attachment` | `zns`.
    pub kind: &'static str,
    pub msg_id: Option<&'a str>,
    pub text: Option<&'a str>,
    pub payload: Value,
    /// `received` | `sent` | `failed`.
    pub status: &'static str,
    pub error: Option<&'a str>,
    pub sent_by: Option<i32>,
    pub at: Option<DateTime<Utc>>,
}

fn preview(m: &RecordMessage<'_>) -> String {
    let t = m.text.unwrap_or(if m.kind == "zns" {
        "[Tin ZNS]"
    } else {
        "[Tệp đính kèm]"
    });
    utf16_prefix(t, PREVIEW_MAX)
}

/// Tìm hoặc tạo hội thoại (không đổi gì khi đã có).
pub async fn upsert_thread(conn: &mut PgConnection, oa_id: &str, zalo_user_id: &str) -> Result<ZaloOaThread, AppError> {
    sqlx::query_as::<_, ZaloOaThread>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO zalo_oa_threads (oa_id, zalo_user_id, updated_at) VALUES ($1, $2, now()) \
         ON CONFLICT (oa_id, zalo_user_id) DO UPDATE SET oa_id = zalo_oa_threads.oa_id RETURNING {THREAD_COLS}"
    )))
    .bind(oa_id)
    .bind(zalo_user_id)
    .fetch_one(conn)
    .await
    .map_err(db)
}

pub async fn get(conn: &mut PgConnection, id: i32) -> Result<ZaloOaThread, AppError> {
    sqlx::query_as::<_, ZaloOaThread>(sqlx::AssertSqlSafe(format!(
        "SELECT {THREAD_COLS} FROM zalo_oa_threads WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(conn)
    .await
    .map_err(db)?
    .ok_or_else(|| HttpError::not_found("Không có hội thoại này").into())
}

/// Cập nhật hồ sơ từ Zalo: trường `None` giữ nguyên.
pub async fn update_profile(
    conn: &mut PgConnection,
    id: i32,
    name: Option<&str>,
    avatar: Option<&str>,
    phone: Option<&str>,
    contact_id: Option<i32>,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE zalo_oa_threads SET display_name = COALESCE($2, display_name), avatar_url = COALESCE($3, avatar_url), \
         phone = COALESCE($4, phone), contact_id = COALESCE($5, contact_id), updated_at = now() WHERE id = $1",
    )
    .bind(id)
    .bind(name)
    .bind(avatar)
    .bind(phone)
    .bind(contact_id)
    .execute(conn)
    .await
    .map_err(db)?;
    Ok(())
}

/// Ghi một tin. `Ok(None)` nếu tin đã có (webhook gửi lại): KHÔNG phát sự kiện lần hai. Tin `failed` chỉ ghi lịch sử, không đổi
/// hội thoại và không phát sự kiện.
pub async fn record(conn: &mut PgConnection, m: &RecordMessage<'_>) -> Result<Option<ZaloOaMessage>, AppError> {
    let at = m.at.unwrap_or_else(Utc::now);
    let thread = get(&mut *conn, m.thread_id).await?;
    let assigned = contacts::assigned_to(&mut *conn, thread.contact_id).await?;
    let mut tx = conn.begin().await.map_err(db)?;
    let inserted = sqlx::query_as::<_, ZaloOaMessage>(sqlx::AssertSqlSafe(format!(
        "INSERT INTO zalo_oa_messages (thread_id, direction, kind, msg_id, text, payload, status, error, sent_by, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6::text::jsonb, $7, $8, $9, $10) RETURNING {MSG_COLS}"
    )))
    .bind(m.thread_id)
    .bind(m.direction)
    .bind(m.kind)
    .bind(m.msg_id)
    .bind(m.text)
    .bind(m.payload.to_string())
    .bind(m.status)
    .bind(m.error)
    .bind(m.sent_by)
    .bind(at)
    .fetch_one(&mut *tx)
    .await;
    let row = match inserted {
        Ok(r) => r,
        Err(e) if db_error(&e).is(DbErrorKind::UniqueViolation, None) => return Ok(None),
        Err(e) => return Err(db(e)),
    };
    if m.status != "failed" {
        let inbound = m.direction == "in";
        sqlx::query(
            "UPDATE zalo_oa_threads SET last_message_preview = $2, last_message_at = $3, \
             last_inbound_at = CASE WHEN $4 THEN $3 ELSE last_inbound_at END, \
             unread_count = unread_count + CASE WHEN $4 THEN 1 ELSE 0 END, updated_at = now() WHERE id = $1",
        )
        .bind(m.thread_id)
        .bind(preview(m))
        .bind(at)
        .bind(inbound)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        publish_integration_event(
            &mut tx,
            if inbound { "zalo_oa.message_received" } else { "zalo_oa.message_sent" },
            &json!({ "thread_id": m.thread_id, "contact_id": thread.contact_id, "contact_assigned_to": assigned, "kind": m.kind }),
            m.thread_id,
            m.sent_by,
        )
        .await
        .map_err(|e| HttpError::new(500, e.to_string()))?;
    }
    tx.commit().await.map_err(db)?;
    Ok(Some(row))
}

/// Trang danh sách hội thoại: mới nhất trước, phân trang bằng `cursor` (id hội thoại cuối trang trước).
#[derive(Debug, Clone, Serialize)]
pub struct ThreadPage {
    pub data: Vec<ZaloOaThread>,
    pub meta: PageMeta,
}

#[derive(Debug, Clone, Serialize)]
pub struct PageMeta {
    pub next_cursor: Option<i32>,
}

/// Thoát `\`, `%`, `_` cho `LIKE ... ESCAPE '\'`.
pub fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `GET /zalo-oa/threads`. `q` tìm theo tên (không phân biệt hoa/thường) hoặc SĐT (chứa), tối đa 100 ký tự (UTF-16).
pub async fn list(
    conn: &mut PgConnection,
    limit: i64,
    cursor: Option<i64>,
    q: Option<&str>,
) -> Result<ThreadPage, AppError> {
    let q = q.map(|s| utf16_prefix(s, 100)).filter(|s| !s.is_empty());
    let mut qb: QueryBuilder<Postgres> =
        QueryBuilder::new(format!("SELECT {THREAD_COLS} FROM zalo_oa_threads WHERE TRUE"));
    if let Some(q) = &q {
        let pat = format!("%{}%", escape_like(q));
        qb.push(" AND (display_name ILIKE ")
            .push_bind(pat.clone())
            .push(" ESCAPE '\\' OR phone LIKE ")
            .push_bind(pat)
            .push(" ESCAPE '\\')");
    }
    if let Some(c) = cursor {
        // Sau dòng con trỏ theo thứ tự (last_message_at DESC NULLS LAST, id DESC); con trỏ không tồn tại ⇒ trang rỗng.
        let cur: Option<Option<DateTime<Utc>>> =
            sqlx::query_scalar("SELECT last_message_at FROM zalo_oa_threads WHERE id::int8 = $1")
                .bind(c)
                .fetch_optional(&mut *conn)
                .await
                .map_err(db)?;
        let Some(cur_at) = cur else {
            return Ok(ThreadPage {
                data: Vec::new(),
                meta: PageMeta { next_cursor: None },
            });
        };
        match cur_at {
            Some(t) => {
                qb.push(" AND (last_message_at < ")
                    .push_bind(t)
                    .push(" OR (last_message_at = ")
                    .push_bind(t)
                    .push(" AND id::int8 < ")
                    .push_bind(c);
                qb.push(") OR last_message_at IS NULL)");
            }
            None => {
                qb.push(" AND last_message_at IS NULL AND id::int8 < ").push_bind(c);
            }
        }
    }
    qb.push(" ORDER BY last_message_at DESC NULLS LAST, id DESC LIMIT ")
        .push_bind(limit + 1);
    let mut rows = qb.build_query_as::<ZaloOaThread>().fetch_all(conn).await.map_err(db)?;
    let more = i64::try_from(rows.len()).is_ok_and(|n| n > limit);
    rows.truncate(usize::try_from(limit).unwrap_or(0));
    let next_cursor = if more { rows.last().map(|t| t.id) } else { None };
    Ok(ThreadPage {
        data: rows,
        meta: PageMeta { next_cursor },
    })
}

/// Tin trả về: `id` là chuỗi (BigInt ra JSON dạng chuỗi như bản Node).
#[derive(Debug, Clone, Serialize)]
pub struct MessageView {
    pub id: String,
    pub thread_id: i32,
    pub direction: String,
    pub kind: String,
    pub msg_id: Option<String>,
    pub text: Option<String>,
    pub payload: JsonValue,
    pub status: String,
    pub error: Option<String>,
    pub sent_by: Option<i32>,
    pub created_at: Timestamp,
    /// SĐT (dạng `0xxxxxxxxx`) phát hiện trong tin KHÁCH gửi; rỗng với tin đi hoặc tin không có số. Web dựa vào đây để hiện nút
    /// «Lưu SĐT vào hồ sơ» (nguồn duy nhất, cùng hàm với `save_phone`).
    pub phones: Vec<String>,
}

impl From<ZaloOaMessage> for MessageView {
    fn from(m: ZaloOaMessage) -> Self {
        let JsBigInt(id) = m.id;
        let phones = match (m.direction.as_str(), m.text.as_deref()) {
            ("in", Some(t)) if m.status != "failed" => detect_phones(t),
            _ => Vec::new(),
        };
        Self {
            phones,
            id: id.to_string(),
            thread_id: m.thread_id,
            direction: m.direction,
            kind: m.kind,
            msg_id: m.msg_id,
            text: m.text,
            payload: m.payload,
            status: m.status,
            error: m.error,
            sent_by: m.sent_by,
            created_at: m.created_at,
        }
    }
}

/// `before` ở query: `^\d{1,18}$` (id tin của trang cũ hơn), không thì 400.
pub fn parse_before(v: &str) -> Result<i64, HttpError> {
    if (1..=18).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_digit()) {
        v.parse().map_err(|_| HttpError::bad_request("before không hợp lệ"))
    } else {
        Err(HttpError::bad_request("before không hợp lệ"))
    }
}

/// `GET /zalo-oa/threads/:id/messages`: mới nhất trước; `before` = id tin để lấy trang cũ hơn. Không có hội thoại ⇒ 404.
pub async fn messages(
    conn: &mut PgConnection,
    thread_id: i32,
    limit: i64,
    before: Option<i64>,
) -> Result<Vec<MessageView>, AppError> {
    get(&mut *conn, thread_id).await?;
    let rows = sqlx::query_as::<_, ZaloOaMessage>(sqlx::AssertSqlSafe(format!(
        "SELECT {MSG_COLS} FROM zalo_oa_messages WHERE thread_id = $1 AND ($2::int8 IS NULL OR id < $2) ORDER BY id DESC LIMIT $3"
    )))
    .bind(thread_id)
    .bind(before)
    .bind(limit)
    .fetch_all(conn)
    .await
    .map_err(db)?;
    Ok(rows.into_iter().map(MessageView::from).collect())
}

/// `POST /zalo-oa/threads/:id/read`.
pub async fn mark_read(conn: &mut PgConnection, id: i32) -> Result<(), AppError> {
    get(&mut *conn, id).await?;
    sqlx::query("UPDATE zalo_oa_threads SET unread_count = 0, updated_at = now() WHERE id = $1")
        .bind(id)
        .execute(conn)
        .await
        .map_err(db)?;
    Ok(())
}

/// `POST /zalo-oa/threads/:id/link`: gán tay hội thoại với khách, theo `contact_id` có sẵn hoặc theo SĐT (tìm/tạo).
pub async fn link(
    conn: &mut PgConnection,
    id: i32,
    contact_id: Option<i32>,
    phone: Option<&str>,
    owner_user_id: i32,
) -> Result<ZaloOaThread, AppError> {
    let t = get(&mut *conn, id).await?;
    let linked = if let Some(cid) = contact_id {
        let c: Option<i32> = sqlx::query_scalar("SELECT id FROM contacts WHERE id = $1 AND deleted_at IS NULL")
            .bind(cid)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
        Some(c.ok_or_else(|| HttpError::not_found("Không có khách này"))?)
    } else if let Some(p) = phone {
        contacts::find_or_create(
            &mut *conn,
            &LinkInput {
                zalo_user_id: &t.zalo_user_id,
                phone: Some(p),
                name: t.display_name.as_deref(),
                owner_user_id,
            },
        )
        .await?
    } else {
        None
    };
    let Some(cid) = linked else {
        return Err(HttpError::not_found("Không tìm/tạo được khách (SĐT không hợp lệ?)").into());
    };
    let zphone = phone.and_then(to_zalo_phone).or(t.phone.clone());
    sqlx::query_as::<_, ZaloOaThread>(sqlx::AssertSqlSafe(format!(
        "UPDATE zalo_oa_threads SET contact_id = $2, phone = $3, updated_at = now() WHERE id = $1 RETURNING {THREAD_COLS}"
    )))
    .bind(id)
    .bind(cid)
    .bind(zphone)
    .fetch_one(conn)
    .await
    .map_err(db)
}

/// Kết quả [`save_phone`].
#[derive(Debug, Clone, Serialize)]
pub struct SavedPhone {
    pub thread: ZaloOaThread,
    pub contact_id: i32,
    /// SĐT đã lưu, dạng nội địa `0xxxxxxxxx`.
    pub phone: String,
    /// `true` nếu phải TẠO khách mới (chưa có hồ sơ nào mang số này).
    pub created: bool,
    /// `true` nếu hội thoại đã ghép sẵn với khách mang đúng số này (không đổi gì).
    pub already: bool,
}

/// Chọn số cần lưu trong danh sách `detected` của một tin: `want` (nếu có) phải là một trong số đó; không chọn thì tin phải có
/// đúng MỘT số.
pub fn pick_phone(detected: &[String], want: Option<&str>) -> Result<String, HttpError> {
    if detected.is_empty() {
        return Err(HttpError::bad_request("Tin này không có số điện thoại"));
    }
    if let Some(w) = want {
        let local = normalize_phone(w).filter(|p| detected.contains(p));
        return local.ok_or_else(|| HttpError::bad_request("Số này không có trong tin nhắn"));
    }
    match detected {
        [one] => Ok(one.clone()),
        _ => Err(HttpError::bad_request("Tin có nhiều số điện thoại, hãy chọn một số")),
    }
}

/// `POST /zalo-oa/threads/:id/save-phone`: lưu SĐT khách GỬI TRONG MỘT TIN vào hồ sơ khách của hội thoại. Máy chủ tự dò số trong
/// tin (không tin số do client gửi). Hội thoại chưa ghép khách ⇒ tìm khách theo số, không có thì tạo (người phụ trách là người
/// bấm, như `link`) rồi ghép. Đã ghép khách mang đúng số ⇒ không đổi gì. Đã ghép khách mang SỐ KHÁC ⇒ 409, KHÔNG ghi đè.
pub async fn save_phone(
    conn: &mut PgConnection,
    thread_id: i32,
    message_id: i64,
    want: Option<&str>,
    user_id: i32,
) -> Result<SavedPhone, AppError> {
    // Một giao dịch, khoá dòng hội thoại: hai lần lưu song song (hoặc lưu đua với `link`) chạy lần lượt, lần sau thấy khách đã ghép
    // nên trả `already`/409 chứ không ghép đè.
    let mut tx = conn.begin().await.map_err(db)?;
    let t = sqlx::query_as::<_, ZaloOaThread>(sqlx::AssertSqlSafe(format!(
        "SELECT {THREAD_COLS} FROM zalo_oa_threads WHERE id = $1 FOR UPDATE"
    )))
    .bind(thread_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db)?
    .ok_or_else(|| AppError::from(HttpError::not_found("Không có hội thoại này")))?;
    let msg: Option<(Option<String>, String, String)> =
        sqlx::query_as("SELECT text, direction, status FROM zalo_oa_messages WHERE id = $1 AND thread_id = $2")
            .bind(message_id)
            .bind(thread_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
    let text = match msg {
        Some((Some(text), dir, status)) if dir == "in" && status != "failed" => text,
        _ => return Err(HttpError::not_found("Không có tin này của khách").into()),
    };
    let local = pick_phone(&detect_phones(&text), want)?;
    let conflict =
        || HttpError::conflict("Hồ sơ khách đã có số điện thoại khác. Hãy sửa ở màn hồ sơ khách nếu cần đổi số");
    let zphone = to_zalo_phone(&local);

    if let Some(cid) = t.contact_id {
        let cur: Option<String> = sqlx::query_scalar("SELECT phone FROM contacts WHERE id = $1 AND deleted_at IS NULL")
            .bind(cid)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db)?;
        // Khách đã ghép mà bị xoá (mềm) thì coi như hội thoại chưa ghép: đi tiếp nhánh tìm/tạo khách bên dưới.
        if let Some(cur) = cur {
            if !same_phone(&cur, &local) {
                return Err(conflict().into());
            }
            // Đúng số rồi: không đổi gì (không ghi `phone`/`updated_at` của hội thoại).
            return Ok(SavedPhone {
                thread: t,
                contact_id: cid,
                phone: local,
                already: true,
                created: false,
            });
        }
    }

    let linked = contacts::find_or_create_flagged(
        &mut tx,
        &LinkInput {
            zalo_user_id: &t.zalo_user_id,
            phone: Some(&local),
            name: t.display_name.as_deref(),
            owner_user_id: user_id,
        },
    )
    .await?;
    let Some((cid, created)) = linked else {
        return Err(HttpError::not_found("Không tìm/tạo được khách (SĐT không hợp lệ?)").into());
    };
    // `find` ưu tiên khách theo `zalo_account`: nếu đó là khách mang số khác thì không ghi đè số, báo xung đột.
    let cur: Option<String> = sqlx::query_scalar("SELECT phone FROM contacts WHERE id = $1")
        .bind(cid)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?;
    if !cur.is_some_and(|c| same_phone(&c, &local)) {
        return Err(conflict().into());
    }
    let thread = set_thread_phone(&mut tx, thread_id, cid, zphone).await?;
    tx.commit().await.map_err(db)?;
    Ok(SavedPhone {
        thread,
        contact_id: cid,
        phone: local,
        already: false,
        created,
    })
}

/// SĐT trong hồ sơ (`stored`, có thể lưu `0…`/`84…`/`+84 …`) có phải số nội địa `local` không.
fn same_phone(stored: &str, local: &str) -> bool {
    normalize_phone(stored).as_deref() == Some(local)
}

async fn set_thread_phone(
    conn: &mut PgConnection,
    id: i32,
    contact_id: i32,
    zphone: Option<String>,
) -> Result<ZaloOaThread, AppError> {
    sqlx::query_as::<_, ZaloOaThread>(sqlx::AssertSqlSafe(format!(
        "UPDATE zalo_oa_threads SET contact_id = $2, phone = COALESCE($3, phone), updated_at = now() WHERE id = $1 RETURNING {THREAD_COLS}"
    )))
    .bind(id)
    .bind(contact_id)
    .bind(zphone)
    .fetch_one(conn)
    .await
    .map_err(db)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chon_so_trong_tin() {
        let one = vec!["0912345678".to_owned()];
        let two = vec!["0912345678".to_owned(), "0987654321".to_owned()];
        assert_eq!(pick_phone(&one, None).unwrap(), "0912345678");
        assert_eq!(pick_phone(&one, Some("+84 912 345 678")).unwrap(), "0912345678");
        assert_eq!(pick_phone(&two, Some("0987.654.321")).unwrap(), "0987654321");
        for (d, w) in [
            (&[][..], None),
            (&two[..], None),
            (&one[..], Some("0987654321")),
            (&one[..], Some("abc")),
        ] {
            assert!(pick_phone(d, w).is_err(), "{d:?} {w:?}");
        }
    }

    #[test]
    fn thoat_like_va_before() {
        assert_eq!(escape_like(r"50%_off\x"), r"50\%\_off\\x");
        assert_eq!(parse_before("123").unwrap(), 123);
        for bad in ["", "12a", "-1", "1234567890123456789", " 1"] {
            assert!(parse_before(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn xem_truoc_tin() {
        let m = |text, kind| RecordMessage {
            thread_id: 1,
            direction: "out",
            kind,
            msg_id: None,
            text,
            payload: json!({}),
            status: "sent",
            error: None,
            sent_by: None,
            at: None,
        };
        assert_eq!(preview(&m(Some("xin chào"), "text")), "xin chào");
        assert_eq!(preview(&m(None, "zns")), "[Tin ZNS]");
        assert_eq!(preview(&m(None, "attachment")), "[Tệp đính kèm]");
        assert_eq!(preview(&m(Some(&"a".repeat(300)), "text")).chars().count(), 200);
    }
}
