//! Giới hạn tốc độ đăng nhập trong RAM: bản chuyển nguyên `RateLimiterService` của bản TS
//! (`services/auth/src/auth/services/rate-limiter.service.ts`): cùng khoá, cùng trần, cửa sổ cố định 15 phút.

use std::collections::HashMap;

const WINDOW_MS: u64 = 15 * 60 * 1000;
const MAX_ATTEMPTS: u32 = 10;
const PUBLIC_MAX_ATTEMPTS: u32 = 5;
const UNTRUSTED_PEER_MAX_ATTEMPTS: u32 = 3000;
const PUBLIC_UNTRUSTED_PEER_MAX_ATTEMPTS: u32 = 1000;
const UNTRUSTED_EMAIL_MAX_ATTEMPTS: u32 = 50;
const UNTRUSTED_ALL_MAX_ATTEMPTS: u32 = 500;

#[derive(Debug, Clone, Copy)]
struct Entry {
    count: u32,
    expires_at: u64,
}

/// Đồng hồ là tham số (mili giây) để test không cần chờ.
#[derive(Debug, Default)]
pub struct RateLimiter {
    store: HashMap<String, Entry>,
}

impl RateLimiter {
    fn attempts_at(&self, key: &str, now: u64) -> u32 {
        match self.store.get(key) {
            Some(e) if now <= e.expires_at => e.count,
            _ => 0,
        }
    }

    /// Số lần đã ghi trong cửa sổ hiện tại.
    pub fn attempts(&self, key: &str, now: u64) -> u32 {
        self.attempts_at(key, now)
    }

    pub fn is_rate_limited(&mut self, key: &str, now: u64) -> bool {
        if key.starts_with("login-untrusted-email:") {
            return self.attempts_at(key, now) >= UNTRUSTED_EMAIL_MAX_ATTEMPTS;
        }
        if key.ends_with("-untrusted-all") {
            return self.attempts_at(key, now) >= UNTRUSTED_ALL_MAX_ATTEMPTS;
        }
        let limit = if key.starts_with("public-login-untrusted:") {
            PUBLIC_UNTRUSTED_PEER_MAX_ATTEMPTS
        } else if key.starts_with("login-untrusted:") {
            UNTRUSTED_PEER_MAX_ATTEMPTS
        } else if key.starts_with("public-login:") {
            PUBLIC_MAX_ATTEMPTS
        } else {
            MAX_ATTEMPTS
        };
        match self.store.get(key) {
            None => false,
            Some(e) if now > e.expires_at => {
                self.store.remove(key);
                false
            }
            Some(e) => e.count >= limit,
        }
    }

    pub fn record_attempt(&mut self, key: &str, now: u64) {
        self.store.retain(|_, e| now <= e.expires_at);
        match self.store.get_mut(key) {
            Some(e) => e.count += 1,
            None => {
                self.store.insert(
                    key.to_owned(),
                    Entry {
                        count: 1,
                        expires_at: now + WINDOW_MS,
                    },
                );
            }
        }
    }

    pub fn reset_attempts(&mut self, key: &str) {
        self.store.remove(key);
    }

    pub fn retry_after_seconds(&self, key: &str, now: u64) -> u64 {
        self.store
            .get(key)
            .map_or(0, |e| e.expires_at.saturating_sub(now).div_ceil(1000))
    }
}

/// Trễ khi IP không tin được: từ lần sai thứ 5 với một email, 1 s, 2 s, 4 s… tối đa 15 s.
pub fn untrusted_delay_ms(attempts: u32) -> u64 {
    if attempts < 5 {
        return 0;
    }
    (1000u64.saturating_mul(1u64 << (attempts - 5).min(20))).min(15_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tran_theo_loai_khoa() {
        let mut r = RateLimiter::default();
        for _ in 0..9 {
            r.record_attempt("login:1.1.1.1:a@x", 0);
        }
        assert!(!r.is_rate_limited("login:1.1.1.1:a@x", 0));
        r.record_attempt("login:1.1.1.1:a@x", 0);
        assert!(r.is_rate_limited("login:1.1.1.1:a@x", 0));
        for _ in 0..5 {
            r.record_attempt("public-login:1.1.1.1:a@x", 0);
        }
        assert!(r.is_rate_limited("public-login:1.1.1.1:a@x", 0));
        for _ in 0..50 {
            r.record_attempt("login-untrusted-email:a@x", 0);
        }
        assert!(r.is_rate_limited("login-untrusted-email:a@x", 0));
        for _ in 0..499 {
            r.record_attempt("register-untrusted-all", 0);
        }
        assert!(!r.is_rate_limited("register-untrusted-all", 0));
        r.record_attempt("register-untrusted-all", 0);
        assert!(r.is_rate_limited("register-untrusted-all", 0));
        // 10 lần khoá IP peer không tin được vẫn chưa chặn (trần 3000)
        for _ in 0..10 {
            r.record_attempt("login-untrusted:10.0.0.1", 0);
        }
        assert!(!r.is_rate_limited("login-untrusted:10.0.0.1", 0));
    }

    #[test]
    fn het_cua_so_va_reset() {
        let mut r = RateLimiter::default();
        for _ in 0..10 {
            r.record_attempt("login:k", 1000);
        }
        assert!(r.is_rate_limited("login:k", 1000 + WINDOW_MS));
        assert!(!r.is_rate_limited("login:k", 1000 + WINDOW_MS + 1));
        assert_eq!(r.attempts("login:k", 1000 + WINDOW_MS + 1), 0);
        r.record_attempt("login:k", 0);
        r.reset_attempts("login:k");
        assert_eq!(r.attempts("login:k", 0), 0);
        r.record_attempt("login:z", 0);
        assert_eq!(r.retry_after_seconds("login:z", 1), 900);
        assert_eq!(r.retry_after_seconds("none", 0), 0);
    }

    #[test]
    fn tre_dan_khi_ip_khong_tin_duoc() {
        let d: Vec<u64> = (0..12).map(untrusted_delay_ms).collect();
        assert_eq!(d, [0, 0, 0, 0, 0, 1000, 2000, 4000, 8000, 15_000, 15_000, 15_000]);
        assert_eq!(untrusted_delay_ms(u32::MAX), 15_000);
    }
}
