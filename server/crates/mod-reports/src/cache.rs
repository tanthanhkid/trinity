//! Cache đọc trong RAM có TTL (`ReadCache` của bản TS): theo tiến trình, khoá có tiền tố công ty, tối đa [`MAX_KEYS`] khoá,
//! tắt được bằng `TRINITY_DISABLE_READ_CACHE=1` (so sánh hai backend).
//!
//! Hai tiến trình không thấy cache của nhau: ghi dữ liệu làm đổi số liệu Tổng quan (tạo, xoá, khôi phục khách…) gọi
//! [`ReadCache::invalidate_prefix`] để xoá cả ở tiến trình này lẫn tiến trình khác (tin `cache` trên kênh `trinity_sync`,
//! `docs/sync-notify.md`); bên nhận chuyển sự kiện vào [`ReadCache::on_sync_event`] (mất kết nối ⇒ xoá hết).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};
use sqlx::PgConnection;
use trinity_db::CompanyRef;
use trinity_db::sync::{self, SyncError, SyncEvent};

/// Trần số khoá (bỏ khoá chèn sớm nhất khi đầy).
pub const MAX_KEYS: usize = 5000;
/// Quét khoá hết hạn tối đa một lần mỗi chu kỳ này.
const SWEEP_INTERVAL: Duration = Duration::from_secs(30);

/// Tiền tố khoá của mọi số liệu Tổng quan (như `invalidatePrefix('dashboard:')` của `ContactsService`).
pub const DASHBOARD_PREFIX: &str = "dashboard:";

#[derive(Debug, Default)]
struct Store {
    map: HashMap<String, Entry>,
    seq: u64,
    last_sweep: Option<Instant>,
}

#[derive(Debug)]
struct Entry {
    expires: Instant,
    seq: u64,
    value: Value,
}

#[derive(Debug, Default)]
pub struct ReadCache {
    disabled: bool,
    store: Mutex<Store>,
}

impl ReadCache {
    pub fn new(disabled: bool) -> Self {
        Self {
            disabled,
            store: Mutex::new(Store::default()),
        }
    }

    /// Đọc `TRINITY_DISABLE_READ_CACHE`: chỉ giá trị `1` (bỏ khoảng trắng hai đầu) là tắt, như `isReadCacheDisabled`.
    pub fn from_env() -> Self {
        Self::new(std::env::var("TRINITY_DISABLE_READ_CACHE").is_ok_and(|v| v.trim() == "1"))
    }

    fn st(&self) -> std::sync::MutexGuard<'_, Store> {
        self.store.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Khoá theo công ty như `tenantKey`: công ty 1 giữ nguyên, công ty khác thêm `c<id>:`.
    pub fn tenant_key(company: CompanyRef, key: &str) -> String {
        Self::tenant_key_id(i64::from(company.id()), key)
    }

    fn tenant_key_id(company: i64, key: &str) -> String {
        if company == 1 {
            key.to_owned()
        } else {
            format!("c{company}:{key}")
        }
    }

    pub fn get(&self, key: &str) -> Option<Value> {
        if self.disabled {
            return None;
        }
        let mut s = self.st();
        match s.map.get(key) {
            Some(e) if e.expires > Instant::now() => Some(e.value.clone()),
            Some(_) => {
                s.map.remove(key);
                None
            }
            None => None,
        }
    }

    pub fn set(&self, key: String, value: Value, ttl: Duration) {
        if self.disabled || ttl.is_zero() {
            return;
        }
        let now = Instant::now();
        let mut s = self.st();
        if s.last_sweep.is_none_or(|t| now.duration_since(t) >= SWEEP_INTERVAL) {
            s.last_sweep = Some(now);
            s.map.retain(|_, e| e.expires > now);
        }
        // Vẫn đầy sau khi quét ⇒ bỏ khoá chèn sớm nhất.
        if !s.map.contains_key(&key)
            && s.map.len() >= MAX_KEYS
            && let Some(oldest) = s.map.iter().min_by_key(|(_, e)| e.seq).map(|(k, _)| k.clone())
        {
            s.map.remove(&oldest);
        }
        s.seq += 1;
        let seq = s.seq;
        s.map.insert(
            key,
            Entry {
                expires: now + ttl,
                seq,
                value,
            },
        );
    }

    pub fn clear(&self) {
        self.st().map.clear();
    }

    pub fn len(&self) -> usize {
        self.st().map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Xoá mọi khoá bắt đầu bằng `prefix` (đã gắn công ty). Trả số khoá đã xoá.
    pub fn delete_prefix(&self, prefix: &str) -> usize {
        let mut s = self.st();
        let before = s.map.len();
        s.map.retain(|k, _| !k.starts_with(prefix));
        before - s.map.len()
    }

    /// `invalidatePrefix`: xoá khoá của công ty `company` bắt đầu bằng `raw_prefix` ở tiến trình này và phát `NOTIFY cache`
    /// (trên `conn`, tức giao dịch của việc ghi: chỉ phát khi commit) để tiến trình khác xoá theo. Gọi sau khi ghi dữ liệu
    /// làm đổi số liệu Tổng quan.
    pub async fn invalidate_prefix(
        &self,
        conn: &mut PgConnection,
        company: CompanyRef,
        raw_prefix: &str,
    ) -> Result<usize, SyncError> {
        let n = self.delete_prefix(&Self::tenant_key(company, raw_prefix));
        let mut f = Map::new();
        f.insert("p".into(), Value::from(raw_prefix));
        sync::publish_in_tx(conn, "cache", i64::from(company.id()), &f).await?;
        Ok(n)
    }

    /// Xử lý một sự kiện từ `trinity_sync`: tin `cache` của tiến trình khác xoá khoá theo tiền tố của công ty trong tin;
    /// `Resync` (vừa nối lại sau lúc đứt, có thể đã lỡ tin) xoá hết.
    pub fn on_sync_event(&self, ev: &SyncEvent) {
        match ev {
            SyncEvent::Resync => self.clear(),
            SyncEvent::Message(env) if env.kind == "cache" => {
                if let Some(p) = env.fields.get("p").and_then(Value::as_str) {
                    self.delete_prefix(&Self::tenant_key_id(env.company, p));
                }
            }
            SyncEvent::Message(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn het_han_tat_va_khoa_cong_ty() {
        let c = ReadCache::new(false);
        c.set("a".into(), serde_json::json!(1), Duration::from_millis(30));
        assert_eq!(c.get("a"), Some(serde_json::json!(1)));
        std::thread::sleep(Duration::from_millis(40));
        assert_eq!(c.get("a"), None);
        let off = ReadCache::new(true);
        off.set("a".into(), serde_json::json!(1), Duration::from_secs(5));
        assert_eq!(off.get("a"), None);
        let c2 = CompanyRef::new(2).unwrap();
        assert_eq!(ReadCache::tenant_key(CompanyRef::DEFAULT, "k"), "k");
        assert_eq!(ReadCache::tenant_key(c2, "k"), "c2:k");
    }

    #[test]
    fn dong_bo_xoa_theo_tien_to_cong_ty() {
        use trinity_db::sync::Envelope;
        let c = ReadCache::new(false);
        let ttl = Duration::from_secs(60);
        let c2 = CompanyRef::new(2).unwrap();
        for k in [
            ReadCache::tenant_key(CompanyRef::DEFAULT, "dashboard:a"),
            ReadCache::tenant_key(c2, "dashboard:a"),
            ReadCache::tenant_key(c2, "crm:x"),
        ] {
            c.set(k, serde_json::json!(1), ttl);
        }
        let msg = |company: i64, kind: &str| {
            let mut fields = Map::new();
            fields.insert("p".into(), Value::from("dashboard:"));
            SyncEvent::Message(Envelope {
                origin: "o".into(),
                kind: kind.into(),
                company,
                fields,
            })
        };
        c.on_sync_event(&msg(2, "bell")); // loại khác: bỏ qua
        assert_eq!(c.len(), 3);
        c.on_sync_event(&msg(2, "cache"));
        assert_eq!(
            (
                c.get("dashboard:a").is_some(),
                c.get("c2:dashboard:a").is_some(),
                c.get("c2:crm:x").is_some()
            ),
            (true, false, true)
        );
        c.on_sync_event(&SyncEvent::Resync);
        assert!(c.is_empty());
    }

    #[test]
    fn tran_5000_khoa_bo_khoa_cu_nhat() {
        let c = ReadCache::new(false);
        for i in 0..=MAX_KEYS {
            c.set(format!("k{i}"), serde_json::json!(i), Duration::from_secs(60));
        }
        assert_eq!(c.len(), MAX_KEYS);
        assert!(c.get("k0").is_none() && c.get("k1").is_some() && c.get(&format!("k{MAX_KEYS}")).is_some());
    }
}
