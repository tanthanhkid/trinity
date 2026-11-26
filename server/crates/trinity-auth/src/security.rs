//! Blacklist token (15 phút) và phiên đang hoạt động (một phiên một người): RAM là lớp nhanh, bảng `token_blacklist` và
//! `active_sessions` (theo schema công ty) là sự thật bền, `NOTIFY trinity_sync` báo các tiến trình khác. Ghi dòng
//! trước, gửi tin sau; tin mang giờ thay đổi `t` và chỉ áp khi không cũ hơn thay đổi đã có. Khởi động và sau khi nối
//! lại kênh thì nạp lại từ bảng. Cùng ngữ nghĩa với `TokenBlacklistService`/`ActiveSessionService` của bản TS.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::postgres::PgListener;
use trinity_db::platform::Platform;
use trinity_db::{CompanyRef, Db};

use crate::sync::{self, CHANNEL, Message};

/// Thời hạn blacklist = thời hạn access token.
pub const TOKEN_TTL_MS: i64 = 15 * 60 * 1000;
/// Mục đã gỡ ở nơi khác chỉ bị xoá khi nạp lại nếu đủ cũ (tránh xoá nhầm thay đổi vừa áp mà bảng chưa kịp thấy).
const RELOAD_GRACE_MS: i64 = 5_000;

type Key = (i32, i32);

#[derive(Debug, Clone)]
struct Block {
    expires_at: i64,
    at: i64,
    /// `false` = đã gỡ: dấu mộ giữ tới hết TTL để tin `block` đến muộn không làm sống lại.
    blocked: bool,
}

#[derive(Debug, Clone)]
struct Sess {
    /// `None` = đã gỡ (dấu mộ).
    sid: Option<String>,
    at: i64,
}

/// Phần RAM, thuần (không DB) để test.
#[derive(Debug, Default)]
pub struct State {
    blocks: HashMap<Key, Block>,
    sessions: HashMap<Key, Sess>,
    last_sweep: i64,
}

impl State {
    pub fn apply_token(&mut self, key: Key, blocked: bool, at: i64) {
        if self.blocks.get(&key).is_some_and(|c| c.at > at) {
            return;
        }
        self.blocks.insert(
            key,
            Block {
                blocked,
                at,
                expires_at: at + TOKEN_TTL_MS,
            },
        );
    }

    pub fn apply_session(&mut self, key: Key, sid: Option<String>, at: i64) {
        if self.sessions.get(&key).is_some_and(|c| c.at > at) {
            return;
        }
        self.sessions.insert(key, Sess { sid, at });
    }

    /// O(1): tra một khoá, mục hết hạn thì xoá tại chỗ; dọn cả bảng tối đa mỗi 60 giây.
    pub fn is_blacklisted(&mut self, key: Key, now: i64) -> bool {
        if now - self.last_sweep > 60_000 {
            self.last_sweep = now;
            self.blocks.retain(|_, e| now <= e.expires_at);
        }
        match self.blocks.get(&key) {
            Some(e) if now > e.expires_at => {
                self.blocks.remove(&key);
                false
            }
            Some(e) => e.blocked,
            None => false,
        }
    }

    /// Fail-open: chưa theo dõi phiên nào, hoặc token không có `sid` ⇒ hợp lệ.
    pub fn is_current_session(&self, key: Key, sid: Option<&str>) -> bool {
        // `!sessionId` của bản Node: chuỗi rỗng cũng là thiếu.
        match (
            self.sessions.get(&key).and_then(|s| s.sid.as_deref()),
            sid.filter(|s| !s.is_empty()),
        ) {
            (None, _) | (_, None) => true,
            (Some(cur), Some(s)) => cur == s,
        }
    }

    /// Áp một tin `token`/`session`; tin lạ hoặc thiếu trường bị bỏ.
    pub fn handle(&mut self, m: &Message) {
        let (Some(u), Some(t)) = (
            m.fields.get("u").and_then(Value::as_i64),
            m.fields.get("t").and_then(Value::as_f64),
        ) else {
            return;
        };
        // Tin không có công ty (`c < 1`) bị bỏ: `tenantKeyFor` của Node cũng không cho khoá hợp lệ.
        let Ok(u) = i32::try_from(u) else { return };
        if m.company < 1 {
            return;
        }
        let key = (m.company, u);
        let t = t as i64;
        let op = m.fields.get("op").and_then(Value::as_str);
        match (m.kind.as_str(), op) {
            ("token", Some(op @ ("block" | "unblock"))) => self.apply_token(key, op == "block", t),
            ("session", Some("clear")) => self.apply_session(key, None, t),
            ("session", Some("start")) => {
                if let Some(s) = m.fields.get("s").and_then(Value::as_str) {
                    self.apply_session(key, Some(s.to_owned()), t);
                }
            }
            _ => {}
        }
    }

    /// Nạp lại một công ty từ bảng: dòng mới hơn thắng; mục đang chặn mà bảng không còn (gỡ ở nơi khác) thì bỏ.
    fn reconcile_blocks(&mut self, company: i32, rows: &[(i32, i64, i64)], now: i64) {
        let mut seen = std::collections::HashSet::new();
        for (u, expires_at, updated_at) in rows {
            let key = (company, *u);
            seen.insert(key);
            if self.blocks.get(&key).is_none_or(|c| c.at <= *updated_at) {
                self.blocks.insert(
                    key,
                    Block {
                        blocked: true,
                        at: *updated_at,
                        expires_at: *expires_at,
                    },
                );
            }
        }
        self.blocks
            .retain(|k, e| k.0 != company || !e.blocked || seen.contains(k) || now - e.at <= RELOAD_GRACE_MS);
    }

    fn reconcile_sessions(&mut self, company: i32, rows: &[(i32, String, i64)], now: i64) {
        let mut seen = std::collections::HashSet::new();
        for (u, sid, started) in rows {
            let key = (company, *u);
            seen.insert(key);
            self.apply_session(key, Some(sid.clone()), *started);
        }
        let stale: Vec<Key> = self
            .sessions
            .iter()
            .filter(|(k, e)| k.0 == company && e.sid.is_some() && !seen.contains(*k) && now - e.at > RELOAD_GRACE_MS)
            .map(|(k, _)| *k)
            .collect();
        for k in stale {
            self.sessions.insert(k, Sess { sid: None, at: now });
        }
    }
}

pub fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn ts(ms: i64) -> DateTime<Utc> {
    DateTime::<Utc>::from_timestamp_millis(ms).unwrap_or_default()
}

/// Trạng thái bảo mật dùng chung cả tiến trình. Tạo MỘT bản, bọc `Arc`.
pub struct Security {
    db: Db,
    platform: Platform,
    origin: String,
    sync_on: bool,
    state: Mutex<State>,
    /// Bộ nghe tin của module khác dùng chung kênh (rbac…): nhận mọi tin đã qua lọc phiên bản và origin.
    handlers: Mutex<Vec<MessageHandler>>,
    resync: Mutex<Vec<ResyncHandler>>,
}

type MessageHandler = Arc<dyn Fn(&Message) + Send + Sync>;
type ResyncHandler = Arc<dyn Fn() + Send + Sync>;

impl Security {
    /// `sync_on = false` (`TRINITY_SYNC=off`): không nghe, không gửi; vẫn ghi bảng.
    pub fn new(db: Db, platform: Platform, sync_on: bool) -> Arc<Self> {
        Arc::new(Self {
            db,
            platform,
            origin: sync::new_origin(),
            sync_on,
            state: Mutex::new(State::default()),
            handlers: Mutex::new(Vec::new()),
            resync: Mutex::new(Vec::new()),
        })
    }

    pub fn platform(&self) -> &Platform {
        &self.platform
    }

    pub fn db(&self) -> &Db {
        &self.db
    }

    /// Đăng ký bộ nghe cho mọi tin của kênh `trinity_sync` (không phải của chính tiến trình này).
    pub fn on_message(&self, f: impl Fn(&Message) + Send + Sync + 'static) {
        self.handlers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(Arc::new(f));
    }

    /// Đăng ký bộ gọi khi kênh vừa nối lại (tin trong lúc đứt đã mất): xoá cache, đọc lại từ DB.
    pub fn on_resync(&self, f: impl Fn() + Send + Sync + 'static) {
        self.resync
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(Arc::new(f));
    }

    fn fire_resync(&self) {
        let hooks: Vec<ResyncHandler> = self
            .resync
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        for h in hooks {
            h();
        }
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    fn st(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn is_blacklisted(&self, company: i32, user: i32) -> bool {
        self.st().is_blacklisted((company, user), now_ms())
    }

    pub fn is_current_session(&self, company: i32, user: i32, sid: Option<&str>) -> bool {
        self.st().is_current_session((company, user), sid)
    }

    /// Áp tin nhận từ kênh (đã lọc origin).
    pub fn handle_payload(&self, payload: &str) {
        if !self.sync_on {
            return;
        }
        if let Some(m) = sync::parse(payload, &self.origin) {
            self.st().handle(&m);
            let hooks: Vec<MessageHandler> = self
                .handlers
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            for h in hooks {
                h(&m);
            }
        }
    }

    /// Gửi một tin lên kênh (fire-and-forget: lỗi chỉ ghi log). `company` 0 = không có ngữ cảnh công ty.
    pub async fn publish(&self, kind: &str, company: i32, fields: Value) {
        if !self.sync_on {
            return;
        }
        let Some(payload) = sync::envelope(&self.origin, kind, company, fields) else {
            tracing::warn!("[sync] payload {kind} quá 7.500 byte, bỏ");
            return;
        };
        if let Err(e) = sqlx::query("SELECT pg_notify($1, $2)")
            .bind(CHANNEL)
            .bind(payload)
            .execute(self.db.raw_pool())
            .await
        {
            tracing::warn!("[sync] gửi NOTIFY {kind} lỗi: {e}");
        }
    }

    /// Chạy một câu ghi bảng bền trong schema công ty; lỗi chỉ ghi log (đăng nhập/đăng xuất không hỏng vì bảng phụ).
    async fn write(
        &self,
        company: i32,
        what: &str,
        q: sqlx::query::Query<'_, sqlx::Postgres, sqlx::postgres::PgArguments>,
    ) {
        let res = async {
            let tenant = self.db.tenant(CompanyRef::new(i64::from(company))?).await?;
            let mut conn = tenant.acquire().await?;
            q.execute(&mut *conn).await?;
            Ok::<(), trinity_db::DbError>(())
        }
        .await;
        if let Err(e) = res {
            tracing::warn!("[security-state] {what}: {e}");
        }
    }

    /// Chặn token của user 15 phút (đăng xuất, khoá, đổi mật khẩu).
    pub async fn blacklist_user(&self, company: i32, user: i32) {
        let at = now_ms();
        self.st().apply_token((company, user), true, at);
        self.write(
            company,
            "ghi blacklist",
            sqlx::query(
                "INSERT INTO token_blacklist (user_id, expires_at, updated_at) VALUES ($1, $2, now())
                 ON CONFLICT (user_id) DO UPDATE SET expires_at = EXCLUDED.expires_at, updated_at = now()",
            )
            .bind(user)
            .bind(ts(at + TOKEN_TTL_MS)),
        )
        .await;
        self.publish("token", company, json!({ "op": "block", "u": user, "t": at }))
            .await;
    }

    pub async fn remove_user(&self, company: i32, user: i32) {
        let at = now_ms();
        self.st().apply_token((company, user), false, at);
        self.write(
            company,
            "xoá blacklist",
            sqlx::query("DELETE FROM token_blacklist WHERE user_id = $1").bind(user),
        )
        .await;
        self.publish("token", company, json!({ "op": "unblock", "u": user, "t": at }))
            .await;
    }

    /// Phiên mới thay phiên cũ; trả `sid` để nhúng vào JWT.
    pub async fn start_session(&self, company: i32, user: i32) -> String {
        let at = now_ms();
        let sid = format!("{}-{}", radix36(at as u64), radix36(u64::from(rand_u32())));
        self.st().apply_session((company, user), Some(sid.clone()), at);
        self.write(
            company,
            "ghi phiên",
            sqlx::query(
                "INSERT INTO active_sessions (user_id, session_id, started_at) VALUES ($1, $2, now())
                 ON CONFLICT (user_id) DO UPDATE SET session_id = EXCLUDED.session_id, started_at = now()",
            )
            .bind(user)
            .bind(sid.clone()),
        )
        .await;
        self.publish(
            "session",
            company,
            json!({ "op": "start", "u": user, "s": sid, "t": at }),
        )
        .await;
        sid
    }

    pub async fn clear_user(&self, company: i32, user: i32) {
        let at = now_ms();
        self.st().apply_session((company, user), None, at);
        self.write(
            company,
            "xoá phiên",
            sqlx::query("DELETE FROM active_sessions WHERE user_id = $1").bind(user),
        )
        .await;
        self.publish("session", company, json!({ "op": "clear", "u": user, "t": at }))
            .await;
    }

    /// Nạp lại mọi công ty đang hoạt động từ bảng bền (lúc khởi động và sau khi nối lại kênh). Không ném.
    pub async fn reload(&self) {
        let companies = match self.platform.list_active_companies().await {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("[security-state] nạp lại: không liệt kê được công ty: {e}");
                return;
            }
        };
        for company in companies {
            if let Err(e) = self.reload_company(company).await {
                tracing::warn!("[security-state] nạp lại công ty {}: {e}", company.id());
            }
        }
    }

    async fn reload_company(&self, company: CompanyRef) -> Result<(), trinity_db::DbError> {
        let tenant = self.db.tenant(company).await?;
        let mut conn = tenant.acquire().await?;
        sqlx::query("DELETE FROM token_blacklist WHERE expires_at < now()")
            .execute(&mut *conn)
            .await?;
        let blocks: Vec<(i32, DateTime<Utc>, DateTime<Utc>)> =
            sqlx::query_as("SELECT user_id, expires_at, updated_at FROM token_blacklist")
                .fetch_all(&mut *conn)
                .await?;
        let sessions: Vec<(i32, String, DateTime<Utc>)> =
            sqlx::query_as("SELECT user_id, session_id, started_at FROM active_sessions")
                .fetch_all(&mut *conn)
                .await?;
        let now = now_ms();
        let blocks: Vec<_> = blocks
            .into_iter()
            .map(|(u, e, up)| (u, e.timestamp_millis(), up.timestamp_millis()))
            .collect();
        let sessions: Vec<_> = sessions
            .into_iter()
            .map(|(u, s, st)| (u, s, st.timestamp_millis()))
            .collect();
        let mut st = self.st();
        st.reconcile_blocks(company.id(), &blocks, now);
        st.reconcile_sessions(company.id(), &sessions, now);
        Ok(())
    }

    /// Nạp từ bảng rồi nghe `trinity_sync`; kênh đứt thì nối lại với back-off và nạp lại. Tắt khi `TRINITY_SYNC=off`.
    pub fn spawn_listener(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let this = Arc::clone(self);
        tokio::spawn(async move {
            this.reload().await;
            if !this.sync_on {
                return;
            }
            let mut backoff = Duration::from_secs(1);
            loop {
                match PgListener::connect_with(this.db.raw_pool()).await {
                    Ok(mut l) => {
                        if let Err(e) = l.listen(CHANNEL).await {
                            tracing::warn!("[sync] LISTEN lỗi: {e}");
                        } else {
                            backoff = Duration::from_secs(1);
                            // Tin đến trong lúc chưa nghe đã mất ⇒ nạp lại từ bảng.
                            this.reload().await;
                            this.fire_resync();
                            loop {
                                match l.try_recv().await {
                                    Ok(Some(n)) => this.handle_payload(n.payload()),
                                    // Kết nối đứt rồi được nối lại ngầm: tin trong lúc đứt đã mất.
                                    Ok(None) => {
                                        this.reload().await;
                                        this.fire_resync();
                                    }
                                    Err(e) => {
                                        tracing::warn!("[sync] kênh lỗi: {e}");
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => tracing::warn!("[sync] không nối được kênh: {e}"),
                }
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(30));
                this.reload().await;
                this.fire_resync();
            }
        })
    }
}

fn radix36(mut n: u64) -> String {
    const D: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(D[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// Số ngẫu nhiên đủ cho id phiên (không phải bí mật: `sid` chỉ để so khớp, token mới là thứ có chữ ký).
fn rand_u32() -> u32 {
    use std::hash::{BuildHasher, Hasher};
    std::collections::hash_map::RandomState::new().build_hasher().finish() as u32
}

#[cfg(test)]
mod tests;
