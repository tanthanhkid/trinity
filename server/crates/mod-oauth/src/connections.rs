//! "Ứng dụng AI đã được cấp quyền" (`ai-connections.service.ts`): mỗi chuỗi token (`family_id`) còn hiệu lực là một kết nối.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::FromRow;
use trinity_db::CompanyRef;
use trinity_integrations::audit::AuditStatus;
use trinity_kernel::vn_time::js_iso_string;

use crate::ctx::OauthCtx;
use crate::error::{OAuthError, R};

const MAX_ROWS: i64 = 200;

#[derive(FromRow)]
struct Head {
    family_id: String,
    client_id: String,
    user_id: i32,
    scopes: Vec<String>,
    last_used_at: Option<DateTime<Utc>>,
    refresh_expires_at: DateTime<Utc>,
}

/// `^[0-9a-f-]{36}$` (không phân biệt hoa/thường).
fn is_family_id(s: &str) -> bool {
    s.len() == 36 && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

fn iso(t: Option<DateTime<Utc>>) -> Value {
    t.map_or(Value::Null, |t| json!(js_iso_string(t)))
}

impl OauthCtx {
    pub async fn list_connections(&self, company: CompanyRef, user_id: i32, all: bool) -> R<Value> {
        let heads: Vec<Head> = {
            let mut c = self.conn(company).await?;
            sqlx::query_as(
                "SELECT family_id, client_id, user_id, COALESCE(scopes, '{}') AS scopes, last_used_at, refresh_expires_at \
                 FROM oauth_tokens WHERE revoked_at IS NULL AND refresh_used_at IS NULL AND refresh_expires_at > now() \
                 AND ($1 OR user_id = $2) ORDER BY id DESC LIMIT $3",
            )
            .bind(all)
            .bind(user_id)
            .bind(MAX_ROWS)
            .fetch_all(&mut *c)
            .await
            .map_err(|e| OAuthError::internal("danh sách kết nối", e))?
        };
        if heads.is_empty() {
            return Ok(json!({ "data": [] }));
        }
        let families: Vec<&str> = heads.iter().map(|h| h.family_id.as_str()).collect();
        let client_ids: Vec<&str> = heads.iter().map(|h| h.client_id.as_str()).collect();
        let user_ids: Vec<i32> = heads.iter().map(|h| h.user_id).collect();
        let firsts: HashMap<String, DateTime<Utc>> = {
            let mut c = self.conn(company).await?;
            let rows: Vec<(String, DateTime<Utc>)> = sqlx::query_as(
                "SELECT family_id, min(created_at) FROM oauth_tokens WHERE family_id = ANY($1) GROUP BY family_id",
            )
            .bind(&families)
            .fetch_all(&mut *c)
            .await
            .map_err(|e| OAuthError::internal("ngày kết nối", e))?;
            rows.into_iter().collect()
        };
        let clients: HashMap<String, (String, String)> = {
            let mut c = self.conn(CompanyRef::DEFAULT).await?;
            let rows: Vec<(String, String, String)> =
                sqlx::query_as("SELECT client_id, name, kind FROM oauth_clients WHERE client_id = ANY($1)")
                    .bind(&client_ids)
                    .fetch_all(&mut *c)
                    .await
                    .map_err(|e| OAuthError::internal("client", e))?;
            rows.into_iter().map(|(id, n, k)| (id, (n, k))).collect()
        };
        let users: HashMap<i32, (Option<String>, String)> = {
            let mut c = self.conn(company).await?;
            let rows: Vec<(i32, Option<String>, String)> =
                sqlx::query_as("SELECT id, full_name, email FROM users WHERE id = ANY($1)")
                    .bind(&user_ids)
                    .fetch_all(&mut *c)
                    .await
                    .map_err(|e| OAuthError::internal("người dùng", e))?;
            rows.into_iter().map(|(id, n, e)| (id, (n, e))).collect()
        };
        let data: Vec<Value> = heads
            .iter()
            .map(|h| {
                let (name, kind) = clients
                    .get(&h.client_id)
                    .cloned()
                    .unwrap_or_else(|| ("Ứng dụng đã xoá".to_owned(), "dcr".to_owned()));
                let (full_name, email) = users.get(&h.user_id).cloned().unwrap_or((None, String::new()));
                json!({
                    "id": h.family_id,
                    "client_id": h.client_id,
                    "client_name": name,
                    "client_kind": kind,
                    "user": { "id": h.user_id, "full_name": full_name, "email": email },
                    "scopes": h.scopes,
                    "connected_at": iso(firsts.get(&h.family_id).copied()),
                    "last_used_at": iso(h.last_used_at),
                    "refresh_expires_at": iso(Some(h.refresh_expires_at)),
                })
            })
            .collect();
        Ok(json!({ "data": data }))
    }

    /// Thu hồi cả chuỗi. Của người khác mà không có `ai_admin` ⇒ `Ok(false)` (route trả 404, không lộ tồn tại).
    pub async fn revoke_connection(&self, company: CompanyRef, family_id: &str, actor: i32, is_admin: bool) -> R<bool> {
        if !is_family_id(family_id) {
            return Ok(false);
        }
        let row: Option<(i32, String)> = {
            let mut c = self.conn(company).await?;
            sqlx::query_as(
                "SELECT user_id, client_id FROM oauth_tokens WHERE family_id = $1 AND revoked_at IS NULL \
                 AND ($2 OR user_id = $3) LIMIT 1",
            )
            .bind(family_id)
            .bind(is_admin)
            .bind(actor)
            .fetch_optional(&mut *c)
            .await
            .map_err(|e| OAuthError::internal("tra kết nối", e))?
        };
        let Some((owner, client_id)) = row else {
            return Ok(false);
        };
        self.revoke_family(company, family_id).await?;
        self.audit(
            company,
            Self::entry(
                "oauth.revoke",
                AuditStatus::Ok,
                &client_id,
                Some(actor),
                json!({ "by": if owner == actor { "owner" } else { "admin" }, "target_user_id": owner }),
            ),
        )
        .await;
        Ok(true)
    }
}
