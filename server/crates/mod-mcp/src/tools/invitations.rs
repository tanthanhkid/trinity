//! Lời mời nhân viên cho AI (M44c, `invitation-tools.ts`): `list_invitations`, `create_invitation`, `cancel_invitation`.
//!
//! Dùng chính `mod_auth` (cùng luật với màn Người dùng: khoá chỗ theo gói, chống leo thang quyền, phạm vi `users.manage`, mời lại thì
//! link cũ chết). Người gọi luôn là `is_admin: false` (vai trò Quản trị không mời qua AI được). Không có tool mật khẩu: tool tạo lời mời
//! chỉ trả `invite_link` (token gốc xuất hiện đúng một lần, không có khoá `token` trong kết quả) và người được mời tự đặt mật khẩu ở link.

use std::sync::Arc;

use mod_auth::{Actor, AuthFail, AuthService, GrantsSource, invitable_roles, invitation_scope};
use serde_json::{Value, json};
use trinity_db::CompanyRef;
use trinity_rbac::OwnerIds;

use super::wrapped;
use crate::args::{opt_int, s};
use crate::auth::Principal;
use crate::exec::{ToolCtx, ToolError, ToolOutput};
use crate::protocol::BoxFuture;

/// Cổng tới `AuthService` (kiểu generic theo nguồn quyền) để `serve` truyền một `Arc<dyn …>`.
pub trait InvitationsPort: Send + Sync {
    fn list<'a>(
        &'a self,
        company: CompanyRef,
        pending_only: bool,
        owners: &'a OwnerIds,
    ) -> BoxFuture<'a, Result<Value, AuthFail>>;

    fn create<'a>(
        &'a self,
        actor: &'a Actor,
        email: &'a str,
        role_id: i32,
        owners: &'a OwnerIds,
    ) -> BoxFuture<'a, Result<Value, AuthFail>>;

    fn revoke<'a>(
        &'a self,
        company: CompanyRef,
        id: i32,
        owners: &'a OwnerIds,
    ) -> BoxFuture<'a, Result<Value, AuthFail>>;
}

/// Bản cài trên `AuthService` thật.
pub struct AuthInvitations<G>(pub Arc<AuthService<G>>);

impl<G: GrantsSource + 'static> InvitationsPort for AuthInvitations<G> {
    fn list<'a>(
        &'a self,
        company: CompanyRef,
        pending_only: bool,
        owners: &'a OwnerIds,
    ) -> BoxFuture<'a, Result<Value, AuthFail>> {
        Box::pin(async move { self.0.list_invitations(company, pending_only, None, owners).await })
    }

    fn create<'a>(
        &'a self,
        actor: &'a Actor,
        email: &'a str,
        role_id: i32,
        owners: &'a OwnerIds,
    ) -> BoxFuture<'a, Result<Value, AuthFail>> {
        Box::pin(async move { self.0.create_invitation(actor, email, role_id, owners).await })
    }

    fn revoke<'a>(
        &'a self,
        company: CompanyRef,
        id: i32,
        owners: &'a OwnerIds,
    ) -> BoxFuture<'a, Result<Value, AuthFail>> {
        Box::pin(async move { self.0.revoke_invitation(company, id, owners).await })
    }
}

fn actor_of(p: &Principal) -> Actor {
    Actor {
        user_id: p.user_id,
        company: p.company,
        is_admin: false,
        grants: p.grants.clone(),
    }
}

/// Lỗi của `mod_auth`: các mã trong `as_user` ⇒ lỗi người dùng với câu nguyên văn (như `ToolUserError` bản TS bắt
/// `ConflictException`/`ForbiddenException`/`NotFoundException`/`GoneException`); còn lại giữ mã cho `failure()`.
fn auth_err(e: &AuthFail, as_user: &[u16]) -> ToolError {
    let http = e.error();
    let status = http.status();
    let message = match http.body().message {
        trinity_kernel::error::Message::One(m) => m,
        trinity_kernel::error::Message::Many(m) => m.join("; "),
    };
    if as_user.contains(&status) {
        ToolError::User(message)
    } else if status >= 500 {
        ToolError::Internal(message)
    } else {
        ToolError::Http { status, message }
    }
}

fn user(msg: &str) -> ToolError {
    ToolError::User(msg.to_owned())
}

async fn scope_of(ctx: &ToolCtx<'_>, actor: &Actor) -> Result<OwnerIds, ToolError> {
    invitation_scope(&ctx.deps.scopes, actor)
        .await
        .map_err(|e| auth_err(&e, &[]))
}

pub(crate) fn list_invitations<'a>(
    port: &'a Arc<dyn InvitationsPort>,
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let p = ctx.principal;
        let actor = actor_of(p);
        // Theo phạm vi users.manage: 'all' thấy hết, phạm vi hẹp chỉ lời mời của người trong phạm vi.
        let owners = scope_of(ctx, &actor).await?;
        let pending_only = args.get("all").and_then(Value::as_bool) != Some(true);
        let rows = port
            .list(p.company, pending_only, &owners)
            .await
            .map_err(|e| auth_err(&e, &[]))?;
        let roles = invitable_roles(&ctx.deps.db, &actor)
            .await
            .map_err(|e| auth_err(&e, &[]))?;
        let invitations: Vec<Value> = rows
            .get("data")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .map(|r| {
                        json!({
                            "id": r.get("id"),
                            "email": r.get("email"),
                            "role": r.get("role_name"),
                            "status": r.get("status"),
                            "expires_at": r.get("expires_at"),
                            "created_at": r.get("created_at"),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let roles: Vec<Value> = roles
            .get("data")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .map(|r| json!({ "id": r.get("id"), "name": r.get("name"), "system": r.get("is_system") }))
                    .collect()
            })
            .unwrap_or_default();
        wrapped(&json!({ "invitations": invitations, "roles": roles }))
    })
}

/// Gốc công khai để dựng link: phải là `http(s)://…`; bỏ dấu `/` cuối.
fn public_origin(base: &str) -> Option<String> {
    let origin = base.trim().trim_end_matches('/');
    let lower = origin.to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://")).then(|| origin.to_owned())
}

pub(crate) fn create_invitation<'a>(
    port: &'a Arc<dyn InvitationsPort>,
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let p = ctx.principal;
        // Không có địa chỉ gốc công khai thì không dựng được link dùng được: báo trước khi tạo, đừng để lại lời mời mồ côi.
        let Some(origin) = public_origin(ctx.base_url) else {
            return Err(user(
                "Máy chủ chưa cấu hình địa chỉ công khai (INTEGRATIONS_PUBLIC_BASE_URL) nên chưa dựng được link mời; chưa tạo lời mời nào. \
                 Hãy báo quản trị máy chủ, hoặc mời bằng nút \"Mời bằng link\" trên màn Người dùng. / \
                 Public base URL is not configured; no invitation was created.",
            ));
        };
        let mut role_id = opt_int(args.get("role_id"));
        if role_id.is_none()
            && let Some(name) = s(args, "role_name").map(str::trim).filter(|n| !n.is_empty())
        {
            let found: Option<i32> =
                sqlx::query_scalar("SELECT id FROM roles WHERE lower(name) = lower($1) ORDER BY id LIMIT 1")
                    .bind(name)
                    .fetch_optional(&mut *ctx.deps.conn(p.company).await?)
                    .await
                    .map_err(|e| ToolError::Internal(e.to_string()))?;
            let Some(id) = found else {
                return Err(ToolError::User(format!(
                    "Không có vai trò tên “{name}”. Xem list_invitations → roles. / Unknown role name."
                )));
            };
            role_id = Some(id);
        }
        let Some(role_id) = role_id else {
            return Err(user(
                "Cần role_id hoặc role_name (xem list_invitations → roles). / role_id or role_name is required.",
            ));
        };
        let actor = actor_of(p);
        let owners = scope_of(ctx, &actor).await?;
        let email = s(args, "email").unwrap_or("");
        let inv = port
            .create(&actor, email, role_id, &owners)
            .await
            .map_err(|e| auth_err(&e, &[403, 404, 409, 410]))?;
        let path = inv.get("path").and_then(Value::as_str).unwrap_or("");
        wrapped(&json!({
            "invitation_id": inv.get("id"),
            "email": inv.get("email"),
            "role": inv.get("role_name"),
            "expires_at": inv.get("expires_at"),
            "invite_link": format!("{origin}{path}"),
            "next_step": "Đưa nguyên invite_link cho người dùng để họ gửi qua Zalo/Messenger. Link chỉ hiện một lần.",
        }))
    })
}

pub(crate) fn cancel_invitation<'a>(
    port: &'a Arc<dyn InvitationsPort>,
    args: &'a Value,
    ctx: &'a ToolCtx<'a>,
) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
    Box::pin(async move {
        let p = ctx.principal;
        let Some(id) = opt_int(args.get("invitation_id")) else {
            return Err(user("invitation_id không hợp lệ. / Invalid invitation_id."));
        };
        let actor = actor_of(p);
        let owners = scope_of(ctx, &actor).await?;
        port.revoke(p.company, id, &owners)
            .await
            .map_err(|e| auth_err(&e, &[404, 409]))?;
        wrapped(&json!({ "invitation_id": id, "status": "revoked" }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use trinity_kernel::error::HttpError;

    #[test]
    fn goc_cong_khai() {
        assert_eq!(
            public_origin("https://crm.example.test/").as_deref(),
            Some("https://crm.example.test")
        );
        assert_eq!(
            public_origin(" HTTP://localhost:3000// ").as_deref(),
            Some("HTTP://localhost:3000")
        );
        for bad in ["", "   ", "crm.example.test", "ftp://x", "/relative"] {
            assert_eq!(public_origin(bad), None, "{bad}");
        }
    }

    #[test]
    fn anh_xa_loi() {
        let conflict: AuthFail = HttpError::conflict("trùng").into();
        assert!(matches!(auth_err(&conflict, &[403, 404, 409, 410]), ToolError::User(m) if m == "trùng"));
        // Ngoài danh sách thì giữ mã: 409 khi huỷ không nằm trong {404, 409}? có; 403 khi huỷ thì không.
        let forbidden: AuthFail = HttpError::forbidden("cấm").into();
        assert!(matches!(
            auth_err(&forbidden, &[404, 409]),
            ToolError::Http { status: 403, .. }
        ));
        let gone: AuthFail = HttpError::nest(410, Some("hết".into())).into();
        assert!(matches!(auth_err(&gone, &[403, 404, 409, 410]), ToolError::User(m) if m == "hết"));
        let boom: AuthFail = HttpError::nest(500, None).into();
        assert!(matches!(auth_err(&boom, &[]), ToolError::Internal(_)));
    }
}
