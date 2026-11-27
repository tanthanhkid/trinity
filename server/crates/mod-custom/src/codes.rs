//! Tiền tố mã bản ghi (chuyển từ `record-codes.ts`): chuẩn hoá, kiểm trùng (hàm DB `trinity_code_prefix_taken`), đổi tên.

use sqlx::PgConnection;

use crate::{R, bad, conflict, db};

pub const RESERVED_CODE_PREFIXES: [&str; 3] = ["KH", "DL", "CV"];

/// 2–4 chữ cái in hoa không dấu, không trùng tiền tố của bảng lõi (KH khách hàng, DL deal, CV công việc).
pub fn normalize_prefix(raw: &str) -> R<String> {
    let p = trinity_kernel::vi::trim_js(raw).to_uppercase();
    if !(2..=4).contains(&p.len()) || !p.bytes().all(|b| b.is_ascii_uppercase()) {
        return Err(bad("Tiền tố mã phải gồm 2–4 chữ cái in hoa không dấu (vd HS, BN, KHO)"));
    }
    if RESERVED_CODE_PREFIXES.contains(&p.as_str()) {
        return Err(bad(format!(
            "Tiền tố “{p}” dành cho bảng lõi (KH = khách hàng, DL = deal, CV = công việc)"
        )));
    }
    Ok(p)
}

pub async fn prefix_taken(conn: &mut PgConnection, prefix: &str, self_id: Option<i32>) -> R<bool> {
    let r: Option<bool> = sqlx::query_scalar("SELECT trinity_code_prefix_taken($1, $2::int)")
        .bind(prefix)
        .bind(self_id)
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
    Ok(r == Some(true))
}

/// Gợi ý tiền tố từ tên (hàm DB `trinity_pick_code_prefix`).
pub async fn suggest_prefix(conn: &mut PgConnection, label: &str) -> R<String> {
    let r: Option<String> = sqlx::query_scalar("SELECT trinity_pick_code_prefix($1, NULL::int)")
        .bind(label)
        .fetch_one(&mut *conn)
        .await
        .map_err(db)?;
    Ok(r.unwrap_or_default())
}

/// Đổi tiền tố: tiền tố cũ thành bí danh (tối đa 20, nên mã cũ vẫn tra được), đánh lại `code` của mọi bản ghi theo
/// `code_seq`. Một khoá advisory toàn công ty giữ hai lượt đổi không chạy chồng.
pub async fn rename_prefix(ctx: &crate::Ctx, company: trinity_db::CompanyRef, object_id: i32, raw: &str) -> R<String> {
    let next = normalize_prefix(raw)?;
    let mut tx = ctx.begin(company).await?;
    sqlx::query("SELECT pg_advisory_xact_lock(7374)")
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    let cur: (Option<String>, Option<Vec<String>>) =
        sqlx::query_as("SELECT code_prefix, code_prefix_aliases FROM custom_objects WHERE id = $1")
            .bind(object_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(db)?;
    if cur.0.as_deref() == Some(next.as_str()) {
        return Ok(next);
    }
    if prefix_taken(&mut tx, &next, Some(object_id)).await? {
        return Err(conflict(format!(
            "Tiền tố “{next}” đã được bảng khác dùng (hoặc từng dùng)"
        )));
    }
    let mut aliases: Vec<String> = Vec::new();
    for p in cur.1.unwrap_or_default().into_iter().chain(cur.0) {
        if p != next && !aliases.contains(&p) {
            aliases.push(p);
        }
    }
    let start = aliases.len().saturating_sub(20);
    let aliases: Vec<String> = aliases.split_off(start);
    sqlx::query(
        "UPDATE custom_objects SET code_prefix = $1, code_prefix_aliases = $2, updated_at = now() WHERE id = $3",
    )
    .bind(&next)
    .bind(&aliases)
    .bind(object_id)
    .execute(&mut *tx)
    .await
    .map_err(db)?;
    sqlx::query("UPDATE custom_records SET code = $1 || trinity_code_num(code_seq) WHERE object_id = $2 AND code_seq IS NOT NULL")
        .bind(&next)
        .bind(object_id)
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    tx.commit().await.map_err(trinity_kernel::error::AppError::internal)?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chuan_hoa_tien_to() {
        assert_eq!(normalize_prefix(" hs ").unwrap(), "HS");
        for bad in ["h", "hsxyz", "h1", "hà", "kh", "DL", "cv", ""] {
            assert!(normalize_prefix(bad).is_err(), "{bad}");
        }
        let e = normalize_prefix("kh").unwrap_err().to_string();
        assert!(e.contains("dành cho bảng lõi"), "{e}");
    }
}
