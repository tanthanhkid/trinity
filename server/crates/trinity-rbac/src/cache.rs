//! Cache quyền trong RAM, TTL 60 giây, khoá theo (công ty, người dùng): id người dùng lặp giữa các công ty. Sửa quyền,
//! vai trò hay cây quản lý gọi [`RbacCache::invalidate_users`]: xoá ngay trong tiến trình và phát `NOTIFY trinity_sync`
//! kind `rbac` (`ids` ≤ 500, vượt thì `"*"`) cho tiến trình khác. Nhận tin thì xoá phần của người dùng đó; kênh nối lại
//! sau lúc đứt thì xoá hết (tin đã mất), TTL là lưới an toàn. Cùng ngữ nghĩa với `rbac-cache.ts`, thêm bộ đếm thế hệ:
//! người đọc DB chụp [`RbacCache::generation`] TRƯỚC khi đọc và chỉ ghi cache nếu thế hệ không đổi, nên lần vô hiệu đến
//! giữa lúc đang đọc (nhiều `await`) không bị ghi đè bằng dữ liệu cũ. Tin `rbac` chỉ xoá công ty hợp lệ (`c ≥ 1`); tin
//! thiếu hoặc sai `c` (kể cả `0`) bị bỏ, như `dropLocal` của Node chỉ xoá khoá tiền tố `c|` đúng.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
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
    /// Tăng mỗi lần xoá (dưới khoá của `inner`). Toàn cache, không theo người dùng: dư vô hiệu chỉ tốn một lần đọc lại.
    generation: AtomicU64,
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
            generation: AtomicU64::new(0),
            ttl,
            inner: Mutex::new(Inner::default()),
        });
        // Weak: `Security` giữ closure suốt đời tiến trình, không được giữ `RbacCache` sống thêm.
        let on_msg: Weak<Self> = Arc::downgrade(&cache);
        security.on_message(move |m| {
            if let Some(c) = on_msg.upgrade() {
                c.handle(m);
            }
        });
        let on_resync: Weak<Self> = Arc::downgrade(&cache);
        security.on_resync(move || {
            if let Some(c) = on_resync.upgrade() {
                c.clear();
            }
        });
        cache
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Thế hệ hiện tại: chụp TRƯỚC khi đọc DB, đưa vào `set_*` sau khi đọc xong.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub fn clear(&self) {
        let mut g = self.lock();
        self.generation.fetch_add(1, Ordering::SeqCst);
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

    /// Ghi cache nếu từ lúc chụp `generation` chưa có lần xoá nào; luôn trả giá trị vừa đọc cho người gọi.
    pub fn set_grants(&self, generation: u64, company: i32, user: i32, v: GrantsResult) -> Arc<GrantsResult> {
        let v = Arc::new(v);
        let mut g = self.lock();
        if self.generation() == generation {
            g.grants
                .insert((company, user), (Arc::clone(&v), Instant::now() + self.ttl));
        }
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

    /// Như [`Self::set_grants`] cho tập id theo phạm vi.
    pub fn set_scope(&self, generation: u64, company: i32, user: i32, scope: Scope, ids: Vec<i32>) -> Arc<Vec<i32>> {
        let v = Arc::new(ids);
        let mut g = self.lock();
        if self.generation() == generation {
            g.scopes
                .insert((company, user, scope), (Arc::clone(&v), Instant::now() + self.ttl));
        }
        v
    }

    /// Xoá trong tiến trình phần của `company` (≥ 1). `company < 1` không xoá gì (không có công ty hợp lệ để nhắm tới).
    pub fn drop_local(&self, company: i32, users: &Users) {
        if company < 1 {
            return;
        }
        let hit = |c: i32, u: i32| {
            c == company
                && match users {
                    Users::All => true,
                    Users::Ids(ids) => ids.contains(&u),
                }
        };
        let mut g = self.lock();
        self.generation.fetch_add(1, Ordering::SeqCst);
        g.grants.retain(|(c, u), _| !hit(*c, *u));
        g.scopes.retain(|(c, u, _), _| !hit(*c, *u));
    }

    /// Sau khi sửa quyền/vai trò/cây quản lý: xoá ngay ở đây rồi báo tiến trình khác. **Chỉ gọi SAU khi giao dịch sửa
    /// đã commit**: gọi trong giao dịch thì request khác đọc lại dữ liệu cũ (chưa commit) và ghi cache cũ ngay sau đó.
    pub async fn invalidate_users(&self, company: i32, users: Users) {
        self.drop_local(company, &users);
        if company < 1 {
            return;
        }
        let ids: Value = match &users {
            Users::Ids(ids) if ids.len() <= MAX_IDS_ON_WIRE => json!(ids),
            _ => json!("*"),
        };
        self.security.publish("rbac", company, json!({ "ids": ids })).await;
    }

    /// Áp tin `rbac` của tiến trình khác. `ids` là `"*"` hoặc mảng số (số nguyên dạng chuỗi hay số thực nguyên cũng nhận,
    /// như `ids.map(Number).filter(Number.isInteger)`); sai dạng hoặc `c < 1` thì bỏ.
    fn handle(&self, m: &Message) {
        if m.kind != "rbac" || m.company < 1 {
            return;
        }
        match m.fields.get("ids") {
            Some(Value::String(s)) if s == "*" => self.drop_local(m.company, &Users::All),
            Some(Value::Array(a)) => {
                let ids: Vec<i32> = a.iter().filter_map(js_integer).collect();
                self.drop_local(m.company, &Users::Ids(ids));
            }
            _ => {}
        }
    }
}

/// `Number(v)` rồi `Number.isInteger`: số, chuỗi số, thực nguyên đều được; còn lại bỏ.
fn js_integer(v: &Value) -> Option<i32> {
    let n = match v {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() { 0.0 } else { t.parse::<f64>().ok()? }
        }
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Null => 0.0,
        _ => return None,
    };
    (n.fract() == 0.0 && n.abs() < f64::from(i32::MAX)).then_some(n as i32)
}

#[cfg(test)]
mod tests;
