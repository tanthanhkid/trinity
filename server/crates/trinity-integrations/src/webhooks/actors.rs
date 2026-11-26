//! "Chủ thể" của endpoint = `created_by`. Payload gửi đi KHÔNG BAO GIỜ rộng hơn quyền của chủ thể. `None` khi chủ thể không
//! còn đủ điều kiện (bị khoá, bị xoá, hoặc mất quyền `integrations.webhooks`) ⇒ endpoint phải ngừng gửi.
//!
//! Việc tính phạm vi cần RBAC (`trinity-rbac`, chưa có trên `main`), nên đây chỉ là giao diện; bản thật cắm vào khi RBAC xong.
//! Quyền đọc từ DB (có cache vô hiệu khi đổi quyền), KHÔNG từ JWT.

use std::future::Future;
use std::pin::Pin;

use trinity_db::TenantDb;

use super::payload::ActorScopes;

pub type ActorFuture<'a> = Pin<Box<dyn Future<Output = Result<Option<ActorScopes>, String>> + Send + 'a>>;

pub trait ActorProvider: Send + Sync {
    fn scopes_for<'a>(&'a self, tenant: &'a TenantDb, user_id: i32) -> ActorFuture<'a>;
}
