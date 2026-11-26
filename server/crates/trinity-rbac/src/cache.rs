//! Cache quyền trong RAM, TTL 60 giây, khoá theo (công ty, người dùng): id người dùng lặp giữa các công ty. Sửa quyền,
//! vai trò hay cây quản lý gọi [`RbacCache::invalidate_users`]: xoá ngay trong tiến trình và phát `NOTIFY trinity_sync`
//! kind `rbac` (`ids` ≤ 500, vượt thì `"*"`) cho tiến trình khác. Nhận tin thì xoá phần của người dùng đó; kênh nối lại
//! sau lúc đứt thì xoá hết (tin đã mất), TTL là lưới an toàn. Cùng ngữ nghĩa với `rbac-cache.ts`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use trinity_auth::Security;
use trinity_auth::sync::Message;

use crate::grants::Scope;
use crate::service::GrantsResult;

pub const DEFAULT_TTL: Duration = Duration::from_secs(60);
/// Quá ngần này id thì payload gần 8 KB: phát "mọi người dùng của công ty".
pub const MAX_IDS_ON_WIRE: usize = 500;

type Entry<T> = (Arc<T>, Instant);

#[derive(Default)]
struct Inner {
    grants: HashMap<(i32, i32), Entry<GrantsResult>>,
    scopes: HashMap<(i32, i32, Scope), Entry<Vec<i32>>>,
}

/// Người dùng cần xoá: danh sách hoặc tất cả.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Users {
    Ids(Vec<i32>),
    All,
}

pub struct RbacCache {
    security: Arc<Security>,
    ttl: Duration,
    inner: Mutex<Inner>,
}

impl RbacCache {
    /// Dựng và nối vào kênh đồng bộ của `security` (nhận tin `rbac`, xoá hết khi nối lại kênh).
    pub fn new(security: Arc<Security>) -> Arc<Self> {
        Self::with_ttl(security, DEFAULT_TTL)
    }

    pub fn with_ttl(security: Arc<Security>, ttl: Duration) -> Arc<Self> {
        let cache = Arc::new(Self {
            security: Arc::clone(&security),
            ttl,
            inner: Mutex::new(Inner::default()),
        });
        let on_msg = Arc::clone(&cache);
        security.on_message(move |m| on_msg.handle(m));
        let on_resync = Arc::clone(&cache);
        security.on_resync(move || on_resync.clear());
        cache
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn clear(&self) {
        let mut g = self.lock();
        g.grants.clear();
        g.scopes.clear();
    }

    pub fn get_grants(&self, company: i32, user: i32) -> Option<Arc<GrantsResult>> {
        let mut g = self.lock();
        match g.grants.get(&(company, user)) {
            Some((v, exp)) if *exp > Instant::now() => Some(Arc::clone(v)),
            Some(_) => {
                g.grants.remove(&(company, user));
                None
            }
            None => None,
        }
    }

    pub fn set_grants(&self, company: i32, user: i32, v: GrantsResult) -> Arc<GrantsResult> {
        let v = Arc::new(v);
        self.lock()
            .grants
            .insert((company, user), (Arc::clone(&v), Instant::now() + self.ttl));
        v
    }

    pub fn get_scope(&self, company: i32, user: i32, scope: Scope) -> Option<Arc<Vec<i32>>> {
        let mut g = self.lock();
        match g.scopes.get(&(company, user, scope)) {
            Some((v, exp)) if *exp > Instant::now() => Some(Arc::clone(v)),
            Some(_) => {
                g.scopes.remove(&(company, user, scope));
                None
            }
            None => None,
        }
    }

    pub fn set_scope(&self, company: i32, user: i32, scope: Scope, ids: Vec<i32>) -> Arc<Vec<i32>> {
        let v = Arc::new(ids);
        self.lock()
            .scopes
            .insert((company, user, scope), (Arc::clone(&v), Instant::now() + self.ttl));
        v
    }

    /// Xoá trong tiến trình. `company` 0 = mọi công ty (tin Node không mang ngữ cảnh công ty).
    pub fn drop_local(&self, company: i32, users: &Users) {
        let hit = |c: i32, u: i32| {
            (company == 0 || c == company)
                && match users {
                    Users::All => true,
                    Users::Ids(ids) => ids.contains(&u),
                }
        };
        let mut g = self.lock();
        g.grants.retain(|(c, u), _| !hit(*c, *u));
        g.scopes.retain(|(c, u, _), _| !hit(*c, *u));
    }

    /// Sau khi sửa quyền/vai trò/cây quản lý: xoá ngay ở đây rồi báo tiến trình khác.
    pub async fn invalidate_users(&self, company: i32, users: Users) {
        self.drop_local(company, &users);
        let ids: Value = match &users {
            Users::Ids(ids) if ids.len() <= MAX_IDS_ON_WIRE => json!(ids),
            _ => json!("*"),
        };
        self.security.publish("rbac", company, json!({ "ids": ids })).await;
    }

    /// Áp tin `rbac` của tiến trình khác.
    fn handle(&self, m: &Message) {
        if m.kind != "rbac" {
            return;
        }
        match m.fields.get("ids") {
            Some(Value::String(s)) if s == "*" => self.drop_local(m.company, &Users::All),
            Some(Value::Array(a)) => {
                let ids: Vec<i32> = a
                    .iter()
                    .filter_map(|v| v.as_i64().and_then(|n| i32::try_from(n).ok()))
                    .collect();
                self.drop_local(m.company, &Users::Ids(ids));
            }
            _ => {}
        }
    }
}
