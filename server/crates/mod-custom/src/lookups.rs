//! Tra cứu cho trường người dùng và liên kết khách (chuyển từ `custom-records-list.service.ts`: `lookupUsers`, `lookupContacts`).

use serde_json::{Value, json};
use sqlx::{Postgres, QueryBuilder};
use trinity_rbac::{OwnerIds, push_scope};

use crate::types::Limits;
use crate::{Actor, Ctx, R, db};

#[derive(Debug, Clone, Default)]
pub struct LookupQuery {
    pub q: Option<String>,
    pub limit: Option<i64>,
    /// `manage` ⇒ lấy trong phạm vi quyền sửa (chọn người phụ trách); còn lại phạm vi quyền xem.
    pub for_manage: bool,
}

impl LookupQuery {
    pub fn from_validated(v: &Value) -> Self {
        Self {
            q: v.get("q").and_then(Value::as_str).map(str::to_owned),
            limit: v.get("limit").and_then(Value::as_i64),
            for_manage: v.get("for").and_then(Value::as_str) == Some("manage"),
        }
    }
}

/// `GET /custom-objects/lookup/users`: người đang hoạt động trong phạm vi (cộng chính mình), tên A→Z, tối đa 50.
pub async fn lookup_users(ctx: &Ctx, actor: &Actor, q: &LookupQuery) -> R<Value> {
    let perm = if q.for_manage {
        "custom_records.manage"
    } else {
        "custom_records.view"
    };
    let owners = ctx
        .scopes
        .owner_ids(actor.company, actor.user_id, &actor.grants, perm)
        .await
        .map_err(trinity_kernel::error::AppError::internal)?
        .unwrap_or_else(|| OwnerIds::Ids(vec![actor.user_id]));
    let scope = match owners {
        OwnerIds::All => OwnerIds::All,
        OwnerIds::Ids(mut v) => {
            if !v.contains(&actor.user_id) {
                v.push(actor.user_id);
            }
            OwnerIds::Ids(v)
        }
    };
    let mut c = ctx.conn(actor.company).await?;
    let mut qb = QueryBuilder::<Postgres>::new(
        "SELECT id, full_name, email FROM users WHERE status = 'active' AND deleted_at IS NULL AND ",
    );
    push_scope(&mut qb, &scope, &["id"]);
    if let Some(t) =
        q.q.as_deref()
            .map(trinity_kernel::vi::trim_js)
            .filter(|t| !t.is_empty())
    {
        // Thoát `\`, `%`, `_`: ký tự đại diện trong ô tìm không khớp mọi thứ.
        let pat = format!("%{}%", trinity_kernel::vi::escape_like(t));
        qb.push(" AND (full_name ILIKE ")
            .push_bind(pat.clone())
            .push(" ESCAPE '\\'")
            .push(" OR email ILIKE ")
            .push_bind(pat)
            .push(" ESCAPE '\\'")
            .push(")");
    }
    qb.push(" ORDER BY full_name ASC LIMIT ")
        .push_bind(q.limit.unwrap_or(50).min(50));
    let rows: Vec<(i32, String, String)> = qb.build_query_as().fetch_all(&mut *c).await.map_err(db)?;
    Ok(Value::Array(
        rows.into_iter()
            .map(|(id, name, email)| json!({ "id": id, "title": if name.is_empty() { email } else { name } }))
            .collect(),
    ))
}

/// `GET /custom-objects/lookup/contacts`: khách trong phạm vi `contacts.view`, cần từ khoá ≥ 2 ký tự, mới nhất trước.
pub async fn lookup_contacts(ctx: &Ctx, actor: &Actor, q: &LookupQuery) -> R<Value> {
    let owners = ctx
        .scopes
        .owner_ids(actor.company, actor.user_id, &actor.grants, "contacts.view")
        .await
        .map_err(trinity_kernel::error::AppError::internal)?;
    let term = q.q.as_deref().map_or("", trinity_kernel::vi::trim_js);
    let Some(owners) = owners.filter(|_| term.chars().count() >= 2) else {
        return Ok(json!([]));
    };
    let mut c = ctx.conn(actor.company).await?;
    let mut qb = QueryBuilder::<Postgres>::new(
        "SELECT id, full_name FROM contacts WHERE deleted_at IS NULL AND full_name ILIKE ",
    );
    qb.push_bind(format!("%{}%", trinity_kernel::vi::escape_like(term)))
        .push(" ESCAPE '\\' AND ");
    push_scope(&mut qb, &owners, &["assigned_to", "created_by_id"]);
    qb.push(" ORDER BY id DESC LIMIT ")
        .push_bind(q.limit.unwrap_or(Limits::LOOKUP_LIMIT).min(50));
    let rows: Vec<(i32, Option<String>)> = qb.build_query_as().fetch_all(&mut *c).await.map_err(db)?;
    Ok(Value::Array(
        rows.into_iter()
            .map(|(id, name)| json!({ "id": id, "title": name.filter(|n| !n.is_empty()).unwrap_or_else(|| format!("Khách #{id}")) }))
            .collect(),
    ))
}
