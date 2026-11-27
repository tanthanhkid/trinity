//! Lead Ads `leadgen` (M47b), chuyển từ `facebook-leads.service.ts` và `facebook-lead-fields.ts`.
//!
//! Webhook chỉ mang `leadgen_id`: gọi Graph lấy `field_data` bằng page token (KHÔNG giữ kết nối khi gọi) rồi tạo/ghép khách.
//! Idempotent theo `leadgen_id` (ràng buộc unique `facebook_lead_receipts_leadgen_id_key`): giao dịch "giành" biên nhận trước, Meta gửi
//! lại hay hai webhook đồng thời thì chỉ một lượt ghi. Khách thuộc `default_assignee_id` của Page; tạo khách phát outbox
//! `contact.created` (origin `facebook_lead`) qua lõi tạo khách chung của `mod-public-api`.

// AppError/HttpError của kernel là kiểu lỗi chung của handler; giữ nguyên, không bọc Box.
#![allow(clippy::result_large_err)]

use std::sync::LazyLock;

use mod_public_api::service::{NewContact, Owner, create_contact_in_tx};
use regex::Regex;
use serde_json::{Value, json};
use sqlx::PgConnection;
use trinity_db::CompanyRef;
use trinity_db::models::FacebookPage;
use trinity_kernel::error::{AppError, HttpError};
use trinity_kernel::phone::{normalize_phone, phone_variants};

use crate::graph::{GraphApiError, LeadField};
use crate::ingest::{FacebookIngest, db, platform_db, str_of, utf16_prefix};
use crate::pages;

/// Kết quả xử lý một `leadgen` (`LeadResult` của bản TS).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeadResult {
    Created,
    Duplicate,
    NoContactInfo,
    OwnerInactive,
    Skipped,
    AlreadyProcessed,
}

impl LeadResult {
    /// Giá trị lưu ở `facebook_lead_receipts.result`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Duplicate => "duplicate",
            Self::NoContactInfo => "no_contact_info",
            Self::OwnerInactive => "owner_inactive",
            Self::Skipped => "skipped",
            Self::AlreadyProcessed => "already_processed",
        }
    }
}

/// `field_data` đã đọc.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedLead {
    pub full_name: Option<String>,
    pub phone: Option<String>,
    pub email: Option<String>,
    /// Các trường còn lại (câu hỏi tuỳ biến của form) — đưa vào ghi chú.
    pub others: Vec<(String, String)>,
}

#[allow(clippy::expect_used)]
fn email_re() -> &'static Regex {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[^@\s]+@[^@\s]+\.[^@\s]+$").expect("regex email"));
    &RE
}

/// `field_data` của Lead Ads → khách. Tên trường chuẩn của Meta: `full_name`, `first_name`, `last_name`, `email`, `phone_number`.
/// SĐT chuẩn hoá về `0xxxxxxxxx` (không ra dạng hợp lệ ⇒ `None`, coi như không có SĐT).
pub fn parse_lead_fields(field_data: &[LeadField]) -> ParsedLead {
    let mut out = ParsedLead::default();
    let (mut first, mut last) = (String::new(), String::new());
    for raw in field_data {
        let key = raw.name.to_lowercase();
        let value = raw
            .values
            .first()
            .map_or("", |v| trinity_kernel::vi::trim_js(v))
            .to_owned();
        if key.is_empty() || value.is_empty() {
            continue;
        }
        match key.as_str() {
            "phone_number" | "phone" | "mobile_phone" | "so_dien_thoai" => {
                if out.phone.is_none() {
                    out.phone = normalize_phone(&value);
                }
            }
            "email" | "work_email" => {
                if out.email.is_none() {
                    out.email = email_re().is_match(&value).then(|| utf16_prefix(&value, 254));
                }
            }
            "full_name" | "name" | "ho_ten" => {
                if out.full_name.is_none() {
                    out.full_name = Some(utf16_prefix(&value, 100));
                }
            }
            "first_name" => first = value,
            "last_name" => last = value,
            _ => out.others.push((utf16_prefix(&key, 60), utf16_prefix(&value, 300))),
        }
    }
    if out.full_name.is_none() && (!first.is_empty() || !last.is_empty()) {
        let joined = format!("{last} {first}");
        out.full_name = Some(utf16_prefix(trinity_kernel::vi::trim_js(&joined), 100));
    }
    out
}

/// `leadgen_id` hợp lệ: `^\d{1,40}$`.
fn valid_leadgen_id(s: &str) -> bool {
    (1..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

/// Ghi chú lịch sử của một lead.
fn activity_description(page_name: &str, p: &ParsedLead, duplicate: bool) -> String {
    let head = if duplicate {
        format!("Khách gửi lại form Lead Ads của \"{page_name}\"")
    } else {
        format!("Tạo từ form Lead Ads của \"{page_name}\"")
    };
    let answers = p
        .others
        .iter()
        .map(|(n, v)| format!("{n}: {v}"))
        .collect::<Vec<_>>()
        .join("; ");
    if answers.is_empty() {
        head
    } else {
        format!("{head}{}", utf16_prefix(&format!(" — {answers}"), 1500))
    }
}

fn graph_to_http(e: &GraphApiError) -> AppError {
    HttpError::new(502, e.message.clone()).into()
}

impl FacebookIngest {
    /// Một thay đổi `leadgen`. Lỗi tạm (mạng/5xx/giới hạn tần suất của Graph) ⇒ `Err` để webhook trả 5xx, Meta gửi lại. Lỗi vĩnh viễn
    /// ⇒ trả kết quả. `value` là `changes[].value`; thiếu `page_id` thì lấy id của entry.
    pub async fn handle_lead(
        &self,
        company: CompanyRef,
        entry_page_id: &str,
        value: &Value,
    ) -> Result<LeadResult, AppError> {
        let leadgen_id = str_of(value.get("leadgen_id"));
        let page_id = str_of(value.get("page_id")).unwrap_or_else(|| entry_page_id.to_owned());
        let form_id = str_of(value.get("form_id")).map(|f| utf16_prefix(&f, 40));
        let Some(leadgen_id) = leadgen_id.filter(|l| valid_leadgen_id(l)) else {
            return Ok(LeadResult::Skipped);
        };
        // Bước 1: đã xử lý chưa + Page/token (một kết nối, trả lại trước khi gọi Graph).
        let (received, found) = {
            let mut c = self.acquire(company).await?;
            let received: bool =
                sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM facebook_lead_receipts WHERE leadgen_id = $1)")
                    .bind(&leadgen_id)
                    .fetch_one(&mut *c)
                    .await
                    .map_err(db)?;
            if received {
                (true, None)
            } else {
                (false, pages::active_page_with_token(&mut c, &self.env, &page_id).await?)
            }
        };
        if received {
            return Ok(LeadResult::AlreadyProcessed);
        }
        let Some((page, token)) = found else {
            return Ok(LeadResult::Skipped);
        };
        // Bước 2: Graph (không giữ kết nối).
        let lead = match (self.graph_for)(company).get_lead(&leadgen_id, &token).await {
            Ok(l) => l,
            Err(err) => {
                if err.is_token_error() {
                    let mut c = self.acquire(company).await?;
                    pages::mark_token_invalid(&mut c, &page_id).await?;
                }
                // Giới hạn tần suất thường là HTTP 400 — KHÔNG được coi là vĩnh viễn: ném để webhook trả 5xx và Meta gửi lại.
                if err.is_rate_limit() {
                    return Err(graph_to_http(&err));
                }
                if err.is_config_error() {
                    tracing::error!(
                        "Lead {leadgen_id}: cấu hình Graph API sai ({}) — bỏ qua, không để Meta gửi lại",
                        err.message
                    );
                    return Ok(LeadResult::Skipped);
                }
                if err.is_token_error() || err.is_permission_error() || (400..500).contains(&err.http_status) {
                    tracing::warn!("Lead {leadgen_id}: không đọc được (code={:?}) — bỏ qua", err.code);
                    return Ok(LeadResult::Skipped);
                }
                return Err(graph_to_http(&err));
            }
        };
        let parsed = parse_lead_fields(lead.field_data.as_deref().unwrap_or(&[]));
        // Bước 3: người nhận khách còn hoạt động?
        let owner: Option<(i32, Option<i32>)> = {
            let mut c = self.acquire(company).await?;
            sqlx::query_as("SELECT id, team_id FROM users WHERE id = $1 AND status = 'active' AND deleted_at IS NULL")
                .bind(page.default_assignee_id)
                .fetch_optional(&mut *c)
                .await
                .map_err(db)?
        };
        let Some((owner_id, team_id)) = owner else {
            tracing::warn!("Lead {leadgen_id}: người nhận của Page {page_id} không còn hoạt động");
            self.receipt(
                company,
                &leadgen_id,
                &page_id,
                form_id.as_deref(),
                LeadResult::OwnerInactive,
            )
            .await?;
            return Ok(LeadResult::OwnerInactive);
        };
        if parsed.phone.is_none() && parsed.email.is_none() {
            self.receipt(
                company,
                &leadgen_id,
                &page_id,
                form_id.as_deref(),
                LeadResult::NoContactInfo,
            )
            .await?;
            return Ok(LeadResult::NoContactInfo);
        }
        self.persist_lead(
            company,
            &page,
            &leadgen_id,
            form_id.as_deref(),
            &parsed,
            &Owner { id: owner_id, team_id },
        )
        .await
    }

    /// Biên nhận không kèm khách. Trùng `leadgen_id` (đua) ⇒ bỏ qua, đã có biên nhận.
    async fn receipt(
        &self,
        company: CompanyRef,
        leadgen_id: &str,
        page_id: &str,
        form_id: Option<&str>,
        result: LeadResult,
    ) -> Result<(), AppError> {
        let mut c = self.acquire(company).await?;
        sqlx::query(
            "INSERT INTO facebook_lead_receipts (leadgen_id, page_id, form_id, contact_id, result) VALUES ($1, $2, $3, NULL, $4) \
             ON CONFLICT (leadgen_id) DO NOTHING",
        )
        .bind(leadgen_id)
        .bind(page_id)
        .bind(form_id)
        .bind(result.as_str())
        .execute(&mut *c)
        .await
        .map_err(db)?;
        Ok(())
    }

    /// MỘT giao dịch: giành biên nhận, khử trùng (SĐT mọi dạng `+84`/`84`/`0` trước, rồi email không phân biệt hoa thường), tạo khách
    /// (cần SĐT: cột `phone` bắt buộc), ghi chú lịch sử, cập nhật biên nhận. Lỗi giữa chừng ⇒ hoàn tác cả biên nhận để Meta gửi lại.
    async fn persist_lead(
        &self,
        company: CompanyRef,
        page: &FacebookPage,
        leadgen_id: &str,
        form_id: Option<&str>,
        p: &ParsedLead,
        owner: &Owner,
    ) -> Result<LeadResult, AppError> {
        let mut tx = self
            .db
            .tenant(company)
            .await
            .map_err(platform_db)?
            .begin()
            .await
            .map_err(platform_db)?;
        let claimed: Option<i64> = sqlx::query_scalar(
            "INSERT INTO facebook_lead_receipts (leadgen_id, page_id, form_id, result) VALUES ($1, $2, $3, 'pending') \
             ON CONFLICT (leadgen_id) DO NOTHING RETURNING id",
        )
        .bind(leadgen_id)
        .bind(&page.page_id)
        .bind(form_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db)?;
        if claimed.is_none() {
            return Ok(LeadResult::AlreadyProcessed);
        }
        let lock_key = p.phone.as_deref().or(p.email.as_deref()).unwrap_or(leadgen_id);
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext(current_schema() || '.facebook_lead.' || $1))")
            .bind(lock_key)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        let dup = find_duplicate(&mut tx, p).await?;
        let (contact_id, duplicate) = match (dup, p.phone.as_deref()) {
            (Some(id), _) => (id, true),
            (None, Some(phone)) => {
                let (id, _) = create_contact_in_tx(
                    &mut tx,
                    &NewContact {
                        phone,
                        full_name: p.full_name.as_deref(),
                        source_id: Some(page.contact_source_id),
                        email: p.email.as_deref(),
                        job_title: None,
                        reminder_notes: None,
                        zalo_account: None,
                        project_id: page.project_id,
                    },
                    owner,
                    "facebook_lead",
                )
                .await?;
                (id, false)
            }
            (None, None) => {
                // Chỉ có email và chưa khớp khách nào: cột phone bắt buộc nên không tạo được.
                sqlx::query("UPDATE facebook_lead_receipts SET result = 'no_contact_info' WHERE leadgen_id = $1")
                    .bind(leadgen_id)
                    .execute(&mut *tx)
                    .await
                    .map_err(db)?;
                tx.commit().await.map_err(platform_db)?;
                return Ok(LeadResult::NoContactInfo);
            }
        };
        let mut metadata = json!({ "facebook_page_id": page.page_id });
        if let (Some(f), Some(m)) = (form_id, metadata.as_object_mut()) {
            m.insert("form_id".to_owned(), json!(f));
        }
        let details =
            json!({ "description": activity_description(&page.name, p, duplicate), "source": "facebook_lead" });
        sqlx::query(
            "INSERT INTO activities (contact_id, action, details, metadata, created_by) \
             VALUES ($1, 'note', $2::text::jsonb, $3::text::jsonb, NULL)",
        )
        .bind(contact_id)
        .bind(trinity_kernel::json::js_json(&details))
        .bind(trinity_kernel::json::js_json(&metadata))
        .execute(&mut *tx)
        .await
        .map_err(db)?;
        let result = if duplicate {
            LeadResult::Duplicate
        } else {
            LeadResult::Created
        };
        sqlx::query("UPDATE facebook_lead_receipts SET contact_id = $2, result = $3 WHERE leadgen_id = $1")
            .bind(leadgen_id)
            .bind(contact_id)
            .bind(result.as_str())
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        tx.commit().await.map_err(platform_db)?;
        Ok(result)
    }
}

/// Khử trùng: SĐT (mọi dạng) trước, rồi email (không phân biệt hoa thường); khách cũ nhất trước.
async fn find_duplicate(conn: &mut PgConnection, p: &ParsedLead) -> Result<Option<i32>, AppError> {
    if let Some(phone) = &p.phone {
        let by_phone: Option<i32> = sqlx::query_scalar(
            "SELECT id FROM contacts WHERE phone = ANY($1) AND deleted_at IS NULL ORDER BY id ASC LIMIT 1",
        )
        .bind(phone_variants(phone))
        .fetch_optional(&mut *conn)
        .await
        .map_err(db)?;
        if by_phone.is_some() {
            return Ok(by_phone);
        }
    }
    if let Some(email) = &p.email {
        return sqlx::query_scalar(
            "SELECT id FROM contacts WHERE lower(email) = lower($1) AND deleted_at IS NULL ORDER BY id ASC LIMIT 1",
        )
        .bind(email)
        .fetch_optional(conn)
        .await
        .map_err(db);
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(name: &str, vals: &[&str]) -> LeadField {
        LeadField {
            name: name.to_owned(),
            values: vals.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    #[test]
    fn doc_field_data() {
        let p = parse_lead_fields(&[
            f("Full_Name", &["  Nguyễn Văn A "]),
            f("phone_number", &["+84 912 345 678"]),
            f("email", &["a@b.vn"]),
            f("Quan_tam", &["Gói VIP"]),
            f("bo_trong", &[""]),
        ]);
        assert_eq!(p.full_name.as_deref(), Some("Nguyễn Văn A"));
        assert_eq!(p.phone.as_deref(), Some("0912345678"));
        assert_eq!(p.email.as_deref(), Some("a@b.vn"));
        assert_eq!(p.others, vec![("quan_tam".to_owned(), "Gói VIP".to_owned())]);
    }

    #[test]
    fn ten_ghep_va_gia_tri_dau_tien_thang() {
        let p = parse_lead_fields(&[
            f("first_name", &["An"]),
            f("last_name", &["Lê"]),
            f("phone", &["abc"]),
            f("phone_number", &["0912345678"]),
        ]);
        assert_eq!(p.full_name.as_deref(), Some("Lê An"), "họ trước tên");
        assert_eq!(p.phone.as_deref(), Some("0912345678"), "SĐT hỏng thì lấy trường sau");
        assert_eq!(
            parse_lead_fields(&[f("first_name", &["An"])]).full_name.as_deref(),
            Some("An")
        );
        let q = parse_lead_fields(&[
            f("full_name", &["X"]),
            f("name", &["Y"]),
            f("email", &["hong"]),
            f("work_email", &["w@x.co"]),
        ]);
        assert_eq!(
            (q.full_name.as_deref(), q.email.as_deref()),
            (Some("X"), Some("w@x.co"))
        );
    }

    #[test]
    fn cat_do_dai() {
        let (a, k, v) = ("a".repeat(150), "k".repeat(80), "v".repeat(400));
        let p = parse_lead_fields(&[f("full_name", &[a.as_str()]), f(&k, &[v.as_str()])]);
        assert_eq!(p.full_name.map(|n| n.len()), Some(100));
        assert_eq!((p.others[0].0.len(), p.others[0].1.len()), (60, 300));
    }

    #[test]
    fn ma_lead_hop_le() {
        assert!(valid_leadgen_id("123456789012345"));
        assert!(valid_leadgen_id(&"1".repeat(40)));
        for bad in ["", "12a", " 1", "1\n", &"1".repeat(41)] {
            assert!(!valid_leadgen_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn ghi_chu_lead() {
        let mut p = ParsedLead::default();
        assert_eq!(
            activity_description("Quán", &p, false),
            "Tạo từ form Lead Ads của \"Quán\""
        );
        p.others = vec![("a".to_owned(), "1".to_owned()), ("b".to_owned(), "2".to_owned())];
        assert_eq!(
            activity_description("Quán", &p, true),
            "Khách gửi lại form Lead Ads của \"Quán\" — a: 1; b: 2"
        );
    }
}
