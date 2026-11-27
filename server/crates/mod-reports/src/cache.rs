//! Cache đọc trong RAM có TTL (`ReadCache` của bản TS): theo tiến trình, khoá có tiền tố công ty, tắt được bằng
//! `TRINITY_DISABLE_READ_CACHE=1` (so sánh hai backend).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;
use trinity_db::CompanyRef;

#[derive(Debug, Default)]
pub struct ReadCache {
    disabled: bool,
    map: Mutex<HashMap<String, (Instant, Value)>>,
}

impl ReadCache {
    pub fn new(disabled: bool) -> Self {
        Self {
            disabled,
            map: Mutex::new(HashMap::new()),
        }
    }

    /// Đọc `TRINITY_DISABLE_READ_CACHE` (`1` hoặc `true` = tắt).
    pub fn from_env() -> Self {
        Self::new(matches!(
            std::env::var("TRINITY_DISABLE_READ_CACHE").as_deref(),
            Ok("1" | "true")
        ))
    }

    /// Khoá theo công ty như `tenantKey`: công ty 1 giữ nguyên, công ty khác thêm `c<id>:`.
    pub fn tenant_key(company: CompanyRef, key: &str) -> String {
        if company.id() == 1 {
            key.to_owned()
        } else {
            format!("c{}:{key}", company.id())
        }
    }

    pub fn get(&self, key: &str) -> Option<Value> {
        if self.disabled {
            return None;
        }
        let mut m = self.map.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        match m.get(key) {
            Some((exp, v)) if *exp > Instant::now() => Some(v.clone()),
            Some(_) => {
                m.remove(key);
                None
            }
            None => None,
        }
    }

    pub fn set(&self, key: String, value: Value, ttl: Duration) {
        if self.disabled {
            return;
        }
        let mut m = self.map.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let now = Instant::now();
        m.retain(|_, (exp, _)| *exp > now);
        m.insert(key, (now + ttl, value));
    }

    pub fn clear(&self) {
        self.map
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
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
}
