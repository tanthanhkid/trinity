//! Tin Messenger vào (M47b), chuyển từ `facebook-messenger.service.ts` (`ingest`, `linkContact`, `ownerFor`, `nameFor`) và
//! `facebook-events.ts` (`publishMessengerEvent`) + `channel-notifications.service.ts` (`notify`).
//!
//! [`FacebookIngest::ingest_message`]: một sự kiện `messaging` có `message.mid`. Idempotent theo `mid`. MỘT giao dịch gồm hội thoại
//! (upsert), tin, ghép/tạo khách, outbox `messenger.message_received|sent` và ghi chú lịch sử; thông báo chuông chạy SAU, ở giao dịch
//! riêng và trong savepoint nên lỗi thông báo không ảnh hưởng tin đã lưu.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use chrono::{DateTime, Utc};
use mod_public_api::service::{NewContact, Owner, create_contact_in_tx};
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_db::models::FacebookPage;
use trinity_db::outbox::{NewNotification, create_notification, publish_integration_event};
use trinity_db::pg_error::db_error;
use trinity_db::{CompanyRef, TenantTx};
use trinity_kernel::error::{AppError, DbErrorKind};
use trinity_kernel::phone::phone_variants;

use crate::ingest::{FacebookIngest, db, platform_db, str_of, utf16_prefix};
use crate::pages;

/// Tin nhắn của khách tới trong cùng hội thoại: chỉ báo chuông lần đầu trong khoảng này (giây).
pub const THROTTLE_SECONDS: f64 = 180.0;
/// Quyền của người quản lý kết nối, cũng được báo chuông.
pub const MANAGER_PERMISSION: &str = "integrations.webhooks";

/// Tên tạm khi chưa lấy được tên Facebook; lấy được tên sau thì chỉ thay khách còn đúng tên tạm này (không đè tên đã sửa tay).
pub fn placeholder_name(psid: &str) -> String {
    let units: Vec<u16> = psid.encode_utf16().collect();
    let tail = String::from_utf16_lossy(&units[units.len().saturating_sub(4)..]);
    format!("Khách Messenger {tail}")
}

fn is_digit(c: char) -> bool {
    c.is_ascii_digit()
}

/// SĐT Việt Nam đầu tiên trong tin (`/(?<![\d+])(?:\+?84|0)(?:[\s.-]?\d){9}(?!\d)/g`, cho phép dấu cách/chấm/gạch) về dạng
/// `0xxxxxxxxx` (`^0[35789]\d{8}$`); không có ⇒ `None`. Viết tay vì `regex` không có lookaround; quét không chồng lấn như `matchAll`.
pub fn find_vn_phone(text: Option<&str>) -> Option<String> {
    let chars: Vec<char> = text?.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let before_ok = i == 0 || !(is_digit(chars[i - 1]) || chars[i - 1] == '+');
        let end = if before_ok { match_phone_at(&chars, i) } else { None };
        let Some(end) = end else {
            i += 1;
            continue;
        };
        let digits: String = chars[i..end].iter().filter(|c| is_digit(**c)).collect();
        let local = match digits.strip_prefix("84") {
            Some(rest) => format!("0{rest}"),
            None => digits,
        };
        let b = local.as_bytes();
        if b.len() == 10 && b[0] == b'0' && matches!(b[1], b'3' | b'5' | b'7' | b'8' | b'9') {
            return Some(local);
        }
        i = end;
    }
    None
}

/// Khớp `(?:\+?84|0)(?:[\s.-]?\d){9}(?!\d)` tại `i`; trả vị trí kết thúc.
fn match_phone_at(c: &[char], i: usize) -> Option<usize> {
    let mut starts = Vec::with_capacity(2);
    let mut j = i;
    if c.get(j) == Some(&'+') {
        j += 1;
    }
    if c.get(j) == Some(&'8') && c.get(j + 1) == Some(&'4') {
        starts.push(j + 2);
    }
    if c.get(i) == Some(&'0') {
        starts.push(i + 1);
    }
    for start in starts {
        let mut p = start;
        let mut ok = true;
        for _ in 0..9 {
            let sep = c.get(p).is_some_and(|x| x.is_whitespace() || *x == '.' || *x == '-');
            if sep && c.get(p + 1).is_some_and(|x| is_digit(*x)) {
                p += 1;
            }
            if c.get(p).is_some_and(|x| is_digit(*x)) {
                p += 1;
            } else {
                ok = false;
                break;
            }
        }
        if ok && !c.get(p).is_some_and(|x| is_digit(*x)) {
            return Some(p);
        }
    }
    None
}

/// `clip(s, n)` của `ChannelNotificationsService`: dài hơn `n` đơn vị UTF-16 thì cắt `n - 1` rồi thêm `…`.
pub(crate) fn clip(s: &str, n: usize) -> String {
    if s.encode_utf16().count() > n {
        format!("{}…", utf16_prefix(s, n - 1))
    } else {
        s.to_owned()
    }
}

/// Tiêu đề và nội dung chuông cho một tin khách (khách mới tạo từ tin này không ghi "đã tạo khách mới": Messenger không có SĐT,
/// bản TS luôn truyền `contactCreated: false`).
pub fn notice_text(channel_name: &str, from_name: Option<&str>, text: Option<&str>) -> (String, String) {
    let who = from_name
        .map(trinity_kernel::vi::trim_js)
        .filter(|s| !s.is_empty())
        .unwrap_or("Khách");
    let flat = text.unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ");
    let shown = if flat.is_empty() {
        "[không có chữ]"
    } else {
        flat.as_str()
    };
    let body = clip(&format!("{who}: {}", clip(shown, 120)), 280);
    (format!("Tin nhắn mới · {channel_name}"), body)
}

/// `new Date(ev.timestamp)` (mili giây); thiếu/0/không đọc được ⇒ giờ hiện tại.
fn event_time(ev: &Value) -> DateTime<Utc> {
    let ms = ev
        .get("timestamp")
        .and_then(|t| t.as_i64().or_else(|| t.as_f64().map(|f| f as i64)));
    ms.filter(|m| *m != 0)
        .and_then(DateTime::from_timestamp_millis)
        .unwrap_or_else(Utc::now)
}

/// Người nhận khách của Page; nghỉ việc thì người đã kết nối Page; cả hai không còn hoạt động ⇒ `None`.
pub(crate) async fn owner_for(conn: &mut PgConnection, page: &FacebookPage) -> Result<Option<Owner>, AppError> {
    for id in [page.default_assignee_id, page.connected_by] {
        let u: Option<(i32, Option<i32>)> =
            sqlx::query_as("SELECT id, team_id FROM users WHERE id = $1 AND status = 'active' AND deleted_at IS NULL")
                .bind(id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(db)?;
        if let Some((id, team_id)) = u {
            return Ok(Some(Owner { id, team_id }));
        }
    }
    Ok(None)
}

/// Ghép người nhắn với khách CRM (`linkContact`): đã ghép ⇒ giữ (điền SĐT nếu khách đang trống); chưa ⇒ theo SĐT trong tin, không có
/// thì tạo khách mới (SĐT trống). Kiểm trùng và tạo nằm dưới khoá advisory theo (schema, Page, psid).
async fn link_contact(
    conn: &mut PgConnection,
    page: &FacebookPage,
    conv_id: i32,
    conv_contact: Option<i32>,
    psid: &str,
    customer_name: Option<&str>,
    text: Option<&str>,
) -> Result<Option<i32>, AppError> {
    let phone = find_vn_phone(text);
    if let Some(cid) = conv_contact {
        if let Some(p) = &phone {
            sqlx::query("UPDATE contacts SET phone = $2 WHERE id = $1 AND phone = ''")
                .bind(cid)
                .bind(p)
                .execute(&mut *conn)
                .await
                .map_err(db)?;
        }
        return Ok(Some(cid));
    }
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext(current_schema() || '.fb_contact.' || $1 || ':' || $2))")
        .bind(&page.page_id)
        .bind(psid)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    let mut contact_id: Option<i32> = None;
    if let Some(p) = &phone {
        contact_id = sqlx::query_scalar(
            "SELECT id FROM contacts WHERE phone = ANY($1) AND deleted_at IS NULL ORDER BY id ASC LIMIT 1",
        )
        .bind(phone_variants(p))
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
    }
    if contact_id.is_none() {
        let Some(owner) = owner_for(&mut *conn, page).await? else {
            tracing::warn!(
                "Không tạo khách từ Messenger (Page {}): người nhận khách và người kết nối Page đều không còn hoạt động",
                page.page_id
            );
            return Ok(None);
        };
        let name = customer_name.map_or_else(|| placeholder_name(psid), str::to_owned);
        let (id, _) = create_contact_in_tx(
            &mut *conn,
            &NewContact {
                phone: phone.as_deref().unwrap_or(""),
                full_name: Some(&name),
                source_id: Some(page.contact_source_id),
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
        contact_id = Some(id);
    }
    sqlx::query("UPDATE facebook_conversations SET contact_id = $2 WHERE id = $1")
        .bind(conv_id)
        .bind(contact_id)
        .execute(conn)
        .await
        .map_err(db)?;
    Ok(contact_id)
}

impl FacebookIngest {
    /// Lưu 1 sự kiện tin nhắn. Trùng `mid` ⇒ `false` (Meta gửi lại khi lỗi, hoặc echo của tin ta vừa gửi). `true` nếu có ghi mới.
    pub async fn ingest_message(&self, company: CompanyRef, page_id: &str, ev: &Value) -> Result<bool, AppError> {
        // delivery/read/postback…: không có `message.mid` ⇒ không phải tin nhắn.
        let Some(m) = ev.get("message").and_then(Value::as_object) else {
            return Ok(false);
        };
        let Some(mid) = m.get("mid").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
            return Ok(false);
        };
        let echo = m.get("is_echo") == Some(&Value::Bool(true));
        let party = if echo { "recipient" } else { "sender" };
        let Some(psid) = str_of(ev.get(party).and_then(|p| p.get("id"))) else {
            return Ok(false);
        };
        // Bước 1: Page + token (kết nối trả lại ngay, không giữ khi gọi Graph).
        let found = {
            let mut c = self.acquire(company).await?;
            pages::active_page_with_token(&mut c, &self.env, page_id).await?
        };
        let Some((page, token)) = found else {
            return Ok(false);
        };
        // Bước 2: đã có tin này chưa, hội thoại đã có tên chưa.
        let (exists, known_name) = {
            let mut c = self.acquire(company).await?;
            let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM facebook_messages WHERE mid = $1)")
                .bind(mid)
                .fetch_one(&mut *c)
                .await
                .map_err(db)?;
            let name: Option<Option<String>> =
                sqlx::query_scalar("SELECT customer_name FROM facebook_conversations WHERE page_id = $1 AND psid = $2")
                    .bind(page_id)
                    .bind(&psid)
                    .fetch_optional(&mut *c)
                    .await
                    .map_err(db)?;
            (exists, name.flatten())
        };
        if exists {
            return Ok(false);
        }
        let text: Option<String> = match m.get("text").and_then(Value::as_str) {
            Some(t) => Some(t.to_owned()),
            None if m
                .get("attachments")
                .and_then(Value::as_array)
                .is_some_and(|a| !a.is_empty()) =>
            {
                Some("[Tệp đính kèm]".to_owned())
            }
            None => None,
        }
        .map(|t| utf16_prefix(&t, 5000));
        let at = event_time(ev);
        // Bước 3: tên Facebook (HTTP, không giữ kết nối); hội thoại đã có tên thì không hỏi lại.
        let name: Option<String> = if echo || known_name.is_some() {
            None
        } else {
            let graph = (self.graph_for)(company);
            match graph.get_user_name(&psid, &token).await {
                Some(n) => Some(n),
                None => graph.get_conversation_name(page_id, &psid, &token).await,
            }
        };
        // Bước 4: MỘT giao dịch.
        let mut tx = self
            .db
            .tenant(company)
            .await
            .map_err(platform_db)?
            .begin()
            .await
            .map_err(platform_db)?;
        let conv: (i32, Option<i32>, Option<String>) = sqlx::query_as(
            "INSERT INTO facebook_conversations (page_id, psid, customer_name, last_message_at, last_message_preview, last_inbound_at, unread_count) \
             VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::bool THEN NULL ELSE $4 END, CASE WHEN $6::bool THEN 0 ELSE 1 END) \
             ON CONFLICT (page_id, psid) DO UPDATE SET last_message_at = $4, last_message_preview = $5, \
             last_inbound_at = CASE WHEN $6::bool THEN facebook_conversations.last_inbound_at ELSE $4 END, \
             unread_count = facebook_conversations.unread_count + CASE WHEN $6::bool THEN 0 ELSE 1 END, \
             customer_name = COALESCE($3, facebook_conversations.customer_name) \
             RETURNING id, contact_id, customer_name",
        )
        .bind(page_id)
        .bind(&psid)
        .bind(name.as_deref())
        .bind(at)
        .bind(text.as_deref().map(|t| utf16_prefix(t, 200)))
        .bind(echo)
        .fetch_one(&mut *tx)
        .await
        .map_err(db)?;
        let (conv_id, conv_contact, conv_name) = conv;
        let inserted = sqlx::query(
            "INSERT INTO facebook_messages (conversation_id, mid, direction, text, sent_at) VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(conv_id)
        .bind(mid)
        .bind(if echo { "out" } else { "in" })
        .bind(text.as_deref())
        .bind(at)
        .execute(&mut *tx)
        .await;
        match inserted {
            Ok(_) => {}
            // Đua với echo của tin ta vừa gửi / Meta gửi lại cùng lúc: bỏ cả giao dịch (drop ⇒ rollback).
            Err(e) if db_error(&e).is(DbErrorKind::UniqueViolation, None) => return Ok(false),
            Err(e) => return Err(db(e)),
        }
        if let (Some(n), Some(cid)) = (&name, conv_contact) {
            sqlx::query("UPDATE contacts SET full_name = $3 WHERE id = $1 AND full_name = $2")
                .bind(cid)
                .bind(placeholder_name(&psid))
                .bind(n)
                .execute(&mut *tx)
                .await
                .map_err(db)?;
        }
        let linked = if echo {
            conv_contact
        } else {
            link_contact(
                &mut tx,
                &page,
                conv_id,
                conv_contact,
                &psid,
                conv_name.as_deref(),
                text.as_deref(),
            )
            .await?
        };
        let contact_id = linked.or(conv_contact);
        let assigned = assigned_to(&mut tx, contact_id).await?;
        publish_integration_event(
            &mut tx,
            if echo {
                "messenger.message_sent"
            } else {
                "messenger.message_received"
            },
            &json!({
                "conversation_id": conv_id, "page_id": page_id, "contact_id": contact_id,
                "contact_assigned_to": assigned, "origin": if echo { "page" } else { "customer" },
            }),
            conv_id,
            None,
        )
        .await
        .map_err(AppError::internal)?;
        if let Some(cid) = contact_id {
            let who = if echo {
                format!("Page \"{}\" trả lời qua Messenger", page.name)
            } else {
                format!("Khách nhắn Page \"{}\" qua Messenger", page.name)
            };
            let description = utf16_prefix(&format!("{who}: {}", text.as_deref().unwrap_or("")), 2000);
            let details = json!({ "description": description, "source": "facebook_messenger" });
            let metadata = json!({
                "facebook_page_id": page_id, "psid": psid, "mid": mid, "direction": if echo { "out" } else { "in" },
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
        // Thông báo chuông: giao dịch riêng, lỗi chỉ ghi log (không hoàn tác tin đã lưu).
        if !echo
            && let Err(e) = self
                .notify(company, &page, conv_id, contact_id, name.as_deref(), text.as_deref())
                .await
        {
            tracing::warn!("Thông báo kênh lỗi (messenger.message_received): {e}");
        }
        Ok(true)
    }

    /// `ChannelNotificationsService.notify` cho tin Messenger: người nhận = người phụ trách khách + người nhận mặc định của Page +
    /// người quản lý kết nối; tin liên tiếp cùng hội thoại trong 3 phút chỉ báo một lần (gộp theo `action_url` riêng từng hội thoại).
    async fn notify(
        &self,
        company: CompanyRef,
        page: &FacebookPage,
        conv_id: i32,
        contact_id: Option<i32>,
        from_name: Option<&str>,
        text: Option<&str>,
    ) -> Result<(), AppError> {
        let mut tx = self
            .db
            .tenant(company)
            .await
            .map_err(platform_db)?
            .begin()
            .await
            .map_err(platform_db)?;
        let owner = assigned_to(&mut tx, contact_id).await?;
        let managers = roster_with_permission(&mut tx, MANAGER_PERMISSION).await?;
        let mut recipients: Vec<i32> = Vec::new();
        for id in [owner, Some(page.default_assignee_id)]
            .into_iter()
            .flatten()
            .chain(managers)
        {
            if id > 0 && !recipients.contains(&id) {
                recipients.push(id);
            }
        }
        if recipients.is_empty() {
            return Ok(());
        }
        let action_url = format!("/inbox?kenh=facebook&hoi_thoai={conv_id}");
        let done: Vec<i32> = sqlx::query_scalar(
            "SELECT DISTINCT recipient_id FROM notification_logs WHERE recipient_id = ANY($1) \
             AND event_type = 'messenger.message_received' AND action_url = $2 \
             AND created_at >= now() - make_interval(secs => $3)",
        )
        .bind(&recipients)
        .bind(&action_url)
        .bind(THROTTLE_SECONDS)
        .fetch_all(&mut *tx)
        .await
        .map_err(db)?;
        recipients.retain(|r| !done.contains(r));
        if recipients.is_empty() {
            return Ok(());
        }
        let (title, body) = notice_text(&page.name, from_name, text);
        let items: Vec<NewNotification> = recipients
            .iter()
            .map(|r| NewNotification {
                recipient_id: *r,
                event_type: "messenger.message_received".to_owned(),
                title: title.clone(),
                body: body.clone(),
                action_url: Some(action_url.clone()),
            })
            .collect();
        notify_in_savepoint(&mut tx, &items).await;
        tx.commit().await.map_err(platform_db)?;
        Ok(())
    }
}

/// Người được giao khách (`assigned_to`), hoặc `None`.
pub(crate) async fn assigned_to(conn: &mut PgConnection, contact_id: Option<i32>) -> Result<Option<i32>, AppError> {
    let Some(id) = contact_id else { return Ok(None) };
    let r: Option<Option<i32>> = sqlx::query_scalar("SELECT assigned_to FROM contacts WHERE id = $1")
        .bind(id)
        .fetch_optional(conn)
        .await
        .map_err(db)?;
    Ok(r.flatten())
}

/// Người dùng đang hoạt động giữ một quyền không-scoped (vai trò hệ thống luôn tính), như `findUserIdsWithPermission`.
pub(crate) async fn roster_with_permission(conn: &mut PgConnection, permission: &str) -> Result<Vec<i32>, AppError> {
    sqlx::query_scalar(
        "SELECT DISTINCT ur.user_id FROM user_roles ur \
         JOIN users u ON u.id = ur.user_id AND u.status = 'active' AND u.deleted_at IS NULL \
         WHERE ur.role_id IN (SELECT r.id FROM roles r WHERE r.is_system OR EXISTS \
         (SELECT 1 FROM role_permissions g WHERE g.role_id = r.id AND g.permission = $1)) \
         ORDER BY ur.user_id",
    )
    .bind(permission)
    .fetch_all(conn)
    .await
    .map_err(db)
}

/// Thông báo KHÔNG được làm hỏng giao dịch: chạy trong SAVEPOINT, lỗi thì rollback to savepoint và ghi log.
pub(crate) async fn notify_in_savepoint(tx: &mut TenantTx, items: &[NewNotification]) {
    if sqlx::query("SAVEPOINT fb_notify").execute(&mut **tx).await.is_err() {
        return;
    }
    match create_notification(tx, items).await {
        Ok(_) => {
            let _ = sqlx::query("RELEASE SAVEPOINT fb_notify").execute(&mut **tx).await;
        }
        Err(e) => {
            tracing::warn!("Gửi thông báo tin Messenger lỗi: {e}");
            let _ = sqlx::query("ROLLBACK TO SAVEPOINT fb_notify").execute(&mut **tx).await;
            let _ = sqlx::query("RELEASE SAVEPOINT fb_notify").execute(&mut **tx).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tim_sdt_trong_tin() {
        let f = |s: &str| find_vn_phone(Some(s));
        assert_eq!(f("gọi em 0912 345 678 nhé").as_deref(), Some("0912345678"));
        assert_eq!(f("zalo +84.912.345.678").as_deref(), Some("0912345678"));
        assert_eq!(f("84912-345-678").as_deref(), Some("0912345678"));
        assert_eq!(f("sđt 0912345678.").as_deref(), Some("0912345678"));
        // Đầu số không phải di động 3/5/7/8/9, thiếu/thừa số, dính vào dãy số dài hoặc sau dấu cộng thì không nhận.
        assert_eq!(f("0212345678"), None, "đầu số 02");
        assert_eq!(f("091234567"), None);
        assert_eq!(f("09123456789"), None, "11 chữ số");
        assert_eq!(f("1230912345678"), None, "dính dãy số dài");
        assert_eq!(f("+0912345678"), None);
        assert_eq!(f("khong co so"), None);
        assert_eq!(find_vn_phone(None), None);
        // Số đầu không hợp lệ thì quét tiếp số sau.
        assert_eq!(f("0212345678 rồi 0987654321").as_deref(), Some("0987654321"));
    }

    #[test]
    fn ten_tam_theo_4_ky_tu_cuoi() {
        assert_eq!(placeholder_name("1234567890"), "Khách Messenger 7890");
        assert_eq!(placeholder_name("12"), "Khách Messenger 12");
    }

    #[test]
    fn noi_dung_chuong() {
        let (t, b) = notice_text("Quán A", Some("  Lan "), Some("  xin   chào\n shop "));
        assert_eq!(
            (t.as_str(), b.as_str()),
            ("Tin nhắn mới · Quán A", "Lan: xin chào shop")
        );
        assert_eq!(notice_text("P", None, None).1, "Khách: [không có chữ]");
        assert_eq!(notice_text("P", Some(" "), Some("a")).1, "Khách: a");
        let long = "x".repeat(200);
        let (_, b) = notice_text("P", Some("L"), Some(&long));
        assert_eq!(b, format!("L: {}…", "x".repeat(119)));
        assert_eq!(clip("abc", 3), "abc");
        assert_eq!(clip("abcd", 3), "ab…");
    }

    #[test]
    fn thoi_gian_su_kien() {
        assert_eq!(
            event_time(&json!({ "timestamp": 1_700_000_000_000_i64 })).timestamp(),
            1_700_000_000
        );
        let now = Utc::now().timestamp();
        for ev in [json!({}), json!({ "timestamp": 0 }), json!({ "timestamp": "x" })] {
            assert!((event_time(&ev).timestamp() - now).abs() < 5);
        }
    }
}
