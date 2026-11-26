//! `FixedWindowLimiter::reset_all` xoá bộ đếm của MỌI limiter trong tiến trình, nên test nằm ở binary riêng (không
//! chạy song song với test limiter khác như trong `src/rate_limit.rs`).

use trinity_http::rate_limit::FixedWindowLimiter;

#[test]
fn reset_all_xoa_moi_bo_dem_va_bo_qua_limiter_da_roi() {
    let a = FixedWindowLimiter::new(1, 60_000);
    let b = FixedWindowLimiter::new(1, 60_000);
    {
        let _gone = FixedWindowLimiter::new(1, 60_000);
    }
    a.hit("k", 0);
    b.hit("k", 0);
    assert!(!a.hit("k", 1).allowed && !b.hit("k", 1).allowed);
    assert_eq!(FixedWindowLimiter::reset_all(), 2);
    assert!(a.hit("k", 2).allowed && b.hit("k", 2).allowed);
}
