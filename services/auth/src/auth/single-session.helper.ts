/**
 * Kill-switch thuần cho "1 tài khoản chỉ 1 phiên đăng nhập".
 *
 * Mirror CHÍNH XÁC mẫu `login-wifi-check.helper.ts` (`isLoginWifiCheckEnabled`):
 * ENV là kill-switch cho ops (không cần đăng nhập UI), CỘNG THÊM (không thay
 * thế) công tắc Settings DB — xem `AuthService.isSingleSessionActive()`. Cả 2
 * mặc định TẮT → merge/deploy KHÔNG đổi hành vi đăng nhập hiện tại.
 */
export function isSingleSessionEnabled(): boolean {
  return process.env.SINGLE_SESSION_ENABLED === 'true'
}
