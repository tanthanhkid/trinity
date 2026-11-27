//! Bản ghi MẪU của hệ thống mới dựng (`sample-records.service.ts`): dữ liệu giả để xem thử, id giữ ở một dòng
//! `settings.sample_records` (JSON). Khi có bản ghi THẬT đầu tiên (khách hoặc bản ghi tuỳ biến, tạo bằng giao diện, API hay AI)
//! mẫu tự xoá mềm và dòng theo dõi biến mất. Mẫu người dùng đã sửa hoặc đã có bản ghi khác liên kết tới được GIỮ (thành dữ liệu thật).

use std::collections::BTreeSet;

use serde_json::Value;
use sqlx::PgConnection;
use trinity_db::CompanyRef;

use crate::{Ctx, R, db, read_setting, write_setting};

/// 1 dòng `settings.sample_records` (JSON) giữ id các bản ghi MẪU còn lại.
pub const SAMPLE_RECORDS_KEY: &str = "sample_records";
/// Khoá giao dịch cho mọi đọc-sửa-ghi danh sách mẫu (hai lần dựng đồng thời không ghi đè nhau).
const LOCK_NS: i32 = 7375;
/// Sửa sau lúc tạo quá ngần này ⇒ coi là người dùng đã chỉnh (mẫu tạo cùng lúc, lệch vài ms).
const EDITED_AFTER_MS: i64 = 2000;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SampleIds {
    pub contacts: Vec<i32>,
    pub records: Vec<i32>,
}

fn ids(v: Option<&Value>) -> Vec<i32> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_i64().and_then(|n| i32::try_from(n).ok()))
                .collect()
        })
        .unwrap_or_default()
}

/// `parseSampleIds`: rỗng hoặc JSON rác ⇒ `None`.
pub fn parse_sample_ids(raw: Option<&str>) -> Option<SampleIds> {
    let v: Value = serde_json::from_str(raw.filter(|s| !s.is_empty())?).ok()?;
    Some(SampleIds {
        contacts: ids(v.get("contacts")),
        records: ids(v.get("records")),
    })
}

fn to_json(s: &SampleIds) -> String {
    format!("{{\"contacts\":{:?},\"records\":{:?}}}", s.contacts, s.records)
}

pub async fn read(conn: &mut PgConnection) -> R<Option<SampleIds>> {
    Ok(parse_sample_ids(
        read_setting(conn, SAMPLE_RECORDS_KEY).await?.as_deref(),
    ))
}

/// Khoá giao dịch (tự nhả khi giao dịch kết thúc). PHẢI gọi trong giao dịch.
pub async fn lock(conn: &mut PgConnection) -> R<()> {
    sqlx::query("SELECT pg_advisory_xact_lock($1, 1)")
        .bind(LOCK_NS)
        .execute(&mut *conn)
        .await
        .map_err(db)?;
    Ok(())
}

/// Ghi thêm id mẫu (gộp với phần đã có), cùng giao dịch với lúc tạo mẫu.
pub async fn register(conn: &mut PgConnection, add: &SampleIds, user: Option<i32>) -> R<()> {
    lock(conn).await?;
    let mut cur = read(conn).await?.unwrap_or_default();
    cur.contacts.extend(&add.contacts);
    cur.records.extend(&add.records);
    write_setting(conn, SAMPLE_RECORDS_KEY, &to_json(&cur), user).await
}

/// Có bản ghi thật (không nằm trong danh sách mẫu, chưa xoá) chưa.
pub async fn has_real(conn: &mut PgConnection, sample: Option<&SampleIds>) -> R<bool> {
    let empty = SampleIds::default();
    let s = sample.unwrap_or(&empty);
    let c: Option<i32> =
        sqlx::query_scalar("SELECT id FROM contacts WHERE deleted_at IS NULL AND id <> ALL($1) LIMIT 1")
            .bind(&s.contacts)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
    if c.is_some() {
        return Ok(true);
    }
    let r: Option<i32> =
        sqlx::query_scalar("SELECT id FROM custom_records WHERE deleted_at IS NULL AND id <> ALL($1) LIMIT 1")
            .bind(&s.records)
            .fetch_optional(&mut *conn)
            .await
            .map_err(db)?;
    Ok(r.is_some())
}

/// Còn mẫu chưa bị dọn không (cho giao diện hiện nhãn "dữ liệu mẫu"); lỗi đọc ⇒ `None`.
pub async fn remaining(conn: &mut PgConnection) -> Option<SampleIds> {
    read(conn).await.ok().flatten()
}

/// Có bản ghi thật ⇒ xoá mẫu. Trả `true` nếu vừa xoá. KHÔNG BAO GIỜ lỗi: việc dọn mẫu không được làm hỏng việc chính.
pub async fn purge_if_real(ctx: &Ctx, company: CompanyRef) -> bool {
    match try_purge(ctx, company).await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("dọn bản ghi mẫu lỗi (bỏ qua): {e}");
            false
        }
    }
}

async fn try_purge(ctx: &Ctx, company: CompanyRef) -> R<bool> {
    // Rẻ, ngoài giao dịch và ngoài khoá: không có dòng mẫu, hoặc chưa có bản ghi thật thì xong ngay (mỗi lần tải trang đều qua đây).
    {
        let mut c = ctx.conn(company).await?;
        let Some(quick) = read(&mut c).await? else {
            return Ok(false);
        };
        if !has_real(&mut c, Some(&quick)).await? {
            return Ok(false);
        }
    }
    let mut tx = ctx.begin(company).await?;
    lock(&mut tx).await?;
    // Đọc lại danh sách và tính lại "có bản ghi thật" TRONG khoá: mẫu đăng ký giữa chừng không bị mất theo dõi.
    let Some(sample) = read(&mut tx).await? else {
        return Ok(false);
    };
    if !has_real(&mut tx, Some(&sample)).await? {
        return Ok(false);
    }
    // Chỉ xoá mẫu còn NGUYÊN: mẫu người dùng đã sửa hoặc đã có bản ghi thật liên kết tới được giữ lại.
    let drop = untouched(&mut tx, &sample).await?;
    if !drop.contacts.is_empty() {
        sqlx::query(
            "UPDATE contacts SET deleted_at = now(), updated_at = now() WHERE id = ANY($1) AND deleted_at IS NULL",
        )
        .bind(&drop.contacts)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    }
    if !drop.records.is_empty() {
        sqlx::query("UPDATE custom_records SET deleted_at = now(), updated_at = now() WHERE id = ANY($1) AND deleted_at IS NULL")
            .bind(&drop.records)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    // Mọi id đã đọc ở trên đều đã xử lý (xoá hoặc gỡ theo dõi); chỉ giữ lại id đăng ký sau đó, dòng rỗng thì xoá.
    let left = read(&mut tx).await?.unwrap_or_default();
    let rest = SampleIds {
        contacts: left
            .contacts
            .into_iter()
            .filter(|i| !sample.contacts.contains(i))
            .collect(),
        records: left
            .records
            .into_iter()
            .filter(|i| !sample.records.contains(i))
            .collect(),
    };
    if rest.contacts.is_empty() && rest.records.is_empty() {
        sqlx::query("DELETE FROM settings WHERE key = $1")
            .bind(SAMPLE_RECORDS_KEY)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    } else {
        sqlx::query("UPDATE settings SET value = $2 WHERE key = $1")
            .bind(SAMPLE_RECORDS_KEY)
            .bind(to_json(&rest))
            .execute(&mut *tx)
            .await
            .map_err(db)?;
    }
    tx.commit().await.map_err(trinity_kernel::error::AppError::internal)?;
    if !drop.contacts.is_empty()
        && let Some(f) = &ctx.contacts_changed
    {
        f(company);
    }
    tracing::info!(
        "đã xoá bản ghi mẫu (khách {}, bản ghi {}) vì có bản ghi thật đầu tiên",
        drop.contacts.len(),
        drop.records.len()
    );
    Ok(true)
}

/// Mẫu còn nguyên: chưa bị sửa và không bị bản ghi nào khác liên kết tới.
async fn untouched(conn: &mut PgConnection, sample: &SampleIds) -> R<SampleIds> {
    let intact = |table: &'static str| {
        format!(
            "SELECT id FROM {table} WHERE id = ANY($1) AND deleted_at IS NULL
               AND (EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000)::bigint <= {EDITED_AFTER_MS}"
        )
    };
    let c_ids: Vec<i32> = if sample.contacts.is_empty() {
        Vec::new()
    } else {
        sqlx::query_scalar(sqlx::AssertSqlSafe(intact("contacts")))
            .bind(&sample.contacts)
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?
    };
    let r_ids: Vec<i32> = if sample.records.is_empty() {
        Vec::new()
    } else {
        sqlx::query_scalar(sqlx::AssertSqlSafe(intact("custom_records")))
            .bind(&sample.records)
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?
    };
    let mut c_ref: BTreeSet<i32> = BTreeSet::new();
    let mut r_ref: BTreeSet<i32> = BTreeSet::new();
    if !c_ids.is_empty() {
        // Ngoại lệ có chủ ý (G07b): cổng thanh toán đã gỡ, `payment_intents` là bảng lưu trữ nhưng vẫn có thể tham chiếu khách;
        // chỉ ĐỌC để không xoá khách đang được tham chiếu.
        let hit: Vec<i32> = sqlx::query_scalar(
            "SELECT DISTINCT contact_id FROM (
                SELECT contact_id FROM deals WHERE contact_id = ANY($1)
                UNION ALL SELECT contact_id FROM activities WHERE contact_id = ANY($1)
                UNION ALL SELECT contact_id FROM kanban_cards WHERE contact_id = ANY($1)
                UNION ALL SELECT contact_id FROM zalo_oa_threads WHERE contact_id = ANY($1)
                UNION ALL SELECT contact_id FROM facebook_conversations WHERE contact_id = ANY($1)
                UNION ALL SELECT contact_id FROM payment_intents WHERE contact_id = ANY($1)
                UNION ALL SELECT contact_id FROM store_orders WHERE contact_id = ANY($1)
             ) t WHERE contact_id IS NOT NULL",
        )
        .bind(&c_ids)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
        c_ref.extend(hit);
    }
    if !c_ids.is_empty() || !r_ids.is_empty() {
        let links: Vec<(String, i32, String, i32)> = sqlx::query_as(
            "SELECT source_type, source_id, target_type, target_id FROM record_links
             WHERE (target_type = 'contact' AND target_id = ANY($1)) OR (target_type = 'record' AND target_id = ANY($2))",
        )
        .bind(&c_ids)
        .bind(&r_ids)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
        for (source_type, source_id, target_type, target_id) in links {
            // Liên kết giữa chính các bản ghi mẫu với nhau không tính.
            if source_type == "record" && sample.records.contains(&source_id) {
                continue;
            }
            if target_type == "contact" {
                c_ref.insert(target_id);
            } else {
                r_ref.insert(target_id);
            }
        }
    }
    // Trường "relation" lưu id ngay trong JSON của bản ghi (không qua record_links): bản ghi thật khác trỏ tới mẫu cũng tính.
    // Chỉ truy vấn đúng các id mẫu bằng jsonb containment theo từng trường relation, không tải JSON của mọi bản ghi.
    let rel_fields: Vec<(String, i32, sqlx::types::Json<Value>)> =
        sqlx::query_as("SELECT key, object_id, options FROM custom_fields WHERE type = 'relation'")
            .fetch_all(&mut *conn)
            .await
            .map_err(db)?;
    for (key, object_id, options) in rel_fields {
        let to_contact = options.0.get("target").and_then(Value::as_str) == Some("contact");
        let wanted = if to_contact { &c_ids } else { &r_ids };
        if wanted.is_empty() {
            continue;
        }
        let hit: Vec<i32> = sqlx::query_scalar(
            "SELECT s.id FROM unnest($1::int[]) AS s(id)
             WHERE EXISTS (SELECT 1 FROM custom_records r WHERE r.object_id = $2 AND r.deleted_at IS NULL
               AND r.id <> ALL($3::int[]) AND (r.data -> $4::text) @> to_jsonb(s.id))",
        )
        .bind(wanted)
        .bind(object_id)
        .bind(&sample.records)
        .bind(&key)
        .fetch_all(&mut *conn)
        .await
        .map_err(db)?;
        if to_contact {
            c_ref.extend(hit)
        } else {
            r_ref.extend(hit)
        }
    }
    Ok(SampleIds {
        contacts: c_ids.into_iter().filter(|i| !c_ref.contains(i)).collect(),
        records: r_ids.into_iter().filter(|i| !r_ref.contains(i)).collect(),
    })
}

/// 3 khách MẪU cho hệ thống "Khác" (CRM cơ bản). Dữ liệu giả, tên ghi rõ "(mẫu)". Trả id đã tạo (đã ghi theo dõi).
pub async fn seed_contacts(conn: &mut PgConnection, user: i32) -> R<Vec<i32>> {
    let stage: Option<i32> = sqlx::query_scalar(
        "SELECT id FROM setting_options WHERE group_key = 'contact_stage' AND value = 'new' LIMIT 1",
    )
    .fetch_optional(&mut *conn)
    .await
    .map_err(db)?;
    let rows: [(&str, &str, Option<&str>, Option<&str>); 3] = [
        (
            "Nguyễn Văn An (mẫu)",
            "0900000001",
            Some("Công ty ABC (mẫu)"),
            Some("an.mau@example.com"),
        ),
        (
            "Trần Thị Bình (mẫu)",
            "0900000002",
            Some("Cửa hàng Hoa Nắng (mẫu)"),
            Some("binh.mau@example.com"),
        ),
        ("Lê Hoàng Cường (mẫu)", "0900000003", None, None),
    ];
    let mut out = Vec::new();
    for (name, phone, company, email) in rows {
        let id: i32 = sqlx::query_scalar(
            "INSERT INTO contacts (full_name, phone, company_name, email, stage_id, assigned_to, created_by_id, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $6, now()) RETURNING id",
        )
        .bind(name)
        .bind(phone)
        .bind(company)
        .bind(email)
        .bind(stage)
        .bind(user)
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
        out.push(id);
    }
    register(
        conn,
        &SampleIds {
            contacts: out.clone(),
            records: Vec::new(),
        },
        Some(user),
    )
    .await?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doc_ghi_danh_sach_mau() {
        assert_eq!(parse_sample_ids(None), None);
        assert_eq!(parse_sample_ids(Some("")), None);
        assert_eq!(parse_sample_ids(Some("{rac")), None);
        let s = parse_sample_ids(Some(r#"{"contacts":[1,2.5,"x",3],"records":[9]}"#)).unwrap();
        assert_eq!((s.contacts.clone(), s.records.clone()), (vec![1, 3], vec![9]));
        assert_eq!(to_json(&s), r#"{"contacts":[1, 3],"records":[9]}"#);
        assert_eq!(parse_sample_ids(Some(&to_json(&s))).unwrap(), s);
    }
}
