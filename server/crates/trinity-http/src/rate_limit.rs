//! Giới hạn tốc độ cửa sổ cố định, trong RAM — bản Rust của `FixedWindowLimiter`
//! (`services/crm/src/common/helpers/fixed-window-limiter.ts`, K25). Không chia sẻ giữa các tiến trình (PLAN mục 1.14,
//! "Lịch sử phản biện" I3): đủ để chống lạm dụng, giới hạn hiệu dụng có thể gấp đôi trong lúc Rust và Node chạy
//! song song. Khoá đếm là chuỗi tuỳ ý; [`company_key`] ghép id công ty vào để cửa sổ tính riêng từng công ty.
//!
//! Thời gian là tham số (mili giây) để test không dùng đồng hồ thật; dùng [`now_ms`] ở chỗ gọi.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock, Weak};
use std::time::{SystemTime, UNIX_EPOCH};

/// Kết quả một lần đếm.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Hit {
    pub allowed: bool,
    pub count: u32,
    /// Giây phải chờ khi bị chặn (>= 1), 0 khi cho qua. Dùng cho header `Retry-After`.
    pub retry_after_sec: u64,
}

#[derive(Debug)]
struct Bucket {
    count: u32,
    expires_at: u64,
}

#[derive(Debug, Default)]
struct State {
    buckets: HashMap<String, Bucket>,
    last_sweep: u64,
}

/// Đếm tối đa `max` lần mỗi khoá trong mỗi cửa sổ `window_ms`.
#[derive(Debug)]
pub struct FixedWindowLimiter {
    max: u32,
    window_ms: u64,
    state: Mutex<State>,
}

type Registry = Mutex<Vec<Weak<FixedWindowLimiter>>>;

fn registry() -> &'static Registry {
    static R: OnceLock<Registry> = OnceLock::new();
    R.get_or_init(|| Mutex::new(Vec::new()))
}

/// Mili giây từ epoch.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Khoá theo công ty: `c<id>:<key>`.
pub fn company_key(company_id: i32, key: &str) -> String {
    format!("c{company_id}:{key}")
}

impl FixedWindowLimiter {
    /// Tạo limiter và đăng ký vào danh sách của [`Self::reset_all`] (API điều khiển test, C18/K34).
    pub fn new(max: u32, window_ms: u64) -> std::sync::Arc<Self> {
        let l = std::sync::Arc::new(Self {
            max,
            window_ms,
            state: Mutex::new(State::default()),
        });
        if let Ok(mut r) = registry().lock() {
            r.retain(|w| w.strong_count() > 0);
            r.push(std::sync::Arc::downgrade(&l));
        }
        l
    }

    pub fn max(&self) -> u32 {
        self.max
    }

    pub fn window_ms(&self) -> u64 {
        self.window_ms
    }

    /// Đếm một lần cho `key` tại thời điểm `now` (ms).
    pub fn hit(&self, key: &str, now: u64) -> Hit {
        let Ok(mut st) = self.state.lock() else {
            // Mutex hỏng (một luồng panic giữa chừng): không chặn người dùng thật vì lỗi nội bộ.
            return Hit {
                allowed: true,
                count: 0,
                retry_after_sec: 0,
            };
        };
        if now.saturating_sub(st.last_sweep) >= self.window_ms {
            st.last_sweep = now;
            st.buckets.retain(|_, b| now <= b.expires_at);
        }
        let window = self.window_ms;
        let fresh = Bucket {
            count: 1,
            expires_at: now.saturating_add(window),
        };
        let b = match st.buckets.get_mut(key) {
            Some(b) if now <= b.expires_at => b,
            _ => {
                st.buckets.insert(key.to_owned(), fresh);
                return Hit {
                    allowed: true,
                    count: 1,
                    retry_after_sec: 0,
                };
            }
        };
        b.count = b.count.saturating_add(1);
        if b.count > self.max {
            return Hit {
                allowed: false,
                count: b.count,
                retry_after_sec: (b.expires_at - now).div_ceil(1000).max(1),
            };
        }
        Hit {
            allowed: true,
            count: b.count,
            retry_after_sec: 0,
        }
    }

    /// Đếm theo công ty.
    pub fn hit_company(&self, company_id: i32, key: &str, now: u64) -> Hit {
        self.hit(&company_key(company_id, key), now)
    }

    /// Xoá mọi bộ đếm của limiter này.
    pub fn reset(&self) {
        if let Ok(mut st) = self.state.lock() {
            st.buckets.clear();
        }
    }

    /// Xoá bộ đếm của MỌI limiter trong tiến trình (chỉ cho API điều khiển test). Trả số limiter đã xoá.
    pub fn reset_all() -> usize {
        let Ok(mut r) = registry().lock() else { return 0 };
        r.retain(|w| w.strong_count() > 0);
        let mut n = 0;
        for l in r.iter().filter_map(Weak::upgrade) {
            l.reset();
            n += 1;
        }
        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dem_chan_va_het_cua_so() {
        let l = FixedWindowLimiter::new(2, 60_000);
        assert_eq!(
            l.hit("a", 1_000),
            Hit {
                allowed: true,
                count: 1,
                retry_after_sec: 0
            }
        );
        assert_eq!(l.hit("a", 2_000).count, 2);
        let h = l.hit("a", 3_000);
        assert_eq!((h.allowed, h.count, h.retry_after_sec), (false, 3, 58));
        // Đúng mốc hết hạn vẫn thuộc cửa sổ cũ (`now > expiresAt` của bản TS), qua mốc thì mở cửa sổ mới.
        assert!(!l.hit("a", 61_000).allowed);
        assert_eq!(
            l.hit("a", 61_001),
            Hit {
                allowed: true,
                count: 1,
                retry_after_sec: 0
            }
        );
        assert_eq!(l.hit("b", 3_000).count, 1);
    }

    #[test]
    fn cua_so_tinh_rieng_tung_cong_ty() {
        let l = FixedWindowLimiter::new(1, 1_000);
        assert!(l.hit_company(1, "hook", 0).allowed);
        assert!(!l.hit_company(1, "hook", 1).allowed);
        assert!(l.hit_company(2, "hook", 1).allowed);
        assert_eq!(company_key(7, "x"), "c7:x");
    }

    #[test]
    fn reset_all_xoa_moi_bo_dem_va_bo_qua_limiter_da_roi() {
        let a = FixedWindowLimiter::new(1, 60_000);
        {
            let _gone = FixedWindowLimiter::new(1, 60_000);
        }
        a.hit("k", 0);
        assert!(!a.hit("k", 1).allowed);
        assert!(FixedWindowLimiter::reset_all() >= 1);
        assert!(a.hit("k", 2).allowed);
    }

    #[test]
    fn don_bucket_het_han() {
        let l = FixedWindowLimiter::new(5, 1_000);
        for i in 0..100 {
            l.hit(&format!("k{i}"), 0);
        }
        l.hit("moi", 5_000);
        assert_eq!(l.state.lock().map(|s| s.buckets.len()).unwrap_or(0), 1);
    }
}
