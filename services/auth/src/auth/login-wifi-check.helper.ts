import type { Request } from 'express'
import { can, type Grants } from '@trinity/rbac'
import { resolveClientIp } from '@trinity/rbac-nest'

/**
 * Kiểm tra đăng nhập theo địa chỉ IP văn phòng (wifi).
 *
 * ⚠️ RỦI RO CAO: khoá sai có thể làm cả đội không đăng nhập được giữa giờ làm.
 * Vì vậy TOÀN BỘ logic ở file này theo nguyên tắc FAIL-OPEN — bất kỳ điểm nào
 * không xác định được dữ liệu (IP, cấu hình văn phòng) đều PHẢI cho đăng nhập,
 * chỉ ghi log. KHÔNG BAO GIỜ đổi thành fail-closed.
 *
 * **Danh sách ÁP DỤNG (opt-in enforcement):** logic union-IP ở
 * file này CHỈ chạy cho user nằm trong `login_wifi_check_targets` — xem
 * `login-wifi-check-targets.helper.ts` (đọc JSDoc đầu file đó TRƯỚC khi đụng,
 * đặc biệt phần "danh sách rỗng nghĩa là gì" — KHÁC ngữ nghĩa fail-open
 * thông thường ở đây).
 *
 * Khác với chấm công (match đúng 1 văn phòng được gán cho nhân viên qua
 * `employees.office_id`), đăng nhập chấp nhận IP của BẤT KỲ văn phòng nào đang
 * `is_active=true`, không yêu cầu nhân viên phải được gán văn phòng cụ thể —
 * xem `AuthService.checkLoginWifi()`. Lý do: giảm rủi ro khoá hàng loạt khi
 * nhiều nhân viên chưa có văn phòng được gán.
 *
 * Kill-switch: `LOGIN_WIFI_CHECK_ENABLED=true` (env) LÀ CỜ TOÀN CỤC MẶC ĐỊNH TẮT.
 * Ngoài ra còn công tắc Settings DB (`login_wifi_check_enabled`, chỉnh qua
 * `GET/PATCH /auth/settings/login-wifi-check`) — hiệu lực khi MỘT TRONG HAI true
 * (`AuthService.isLoginWifiCheckActive()`); mặc định cả hai đều tắt.
 * `LOGIN_WIFI_CHECK_BYPASS_EMAILS` — danh sách email (hoặc user id) CSV, không phân
 * biệt hoa/thường, luôn được bỏ qua check kể cả khi bật (vd tài khoản demo/test).
 * Người có quyền `settings.integrations` LUÔN bypass (không thể tự khoá chân mình
 * khi thao tác Settings).
 *
 * IP khách lấy từ hàm dùng chung `resolveClientIp` (`@trinity/rbac-nest`, cấu hình `TRUSTED_PROXY`; xem
 * docs/deployment.md mục "Client IP"). IP không tin được (thiếu cấu hình proxy) ⇒ gate CHO QUA và hiện dải cảnh báo
 * quản trị, không khoá ai.
 */

/**
 * Khoá IP cho giới hạn tốc độ và nhật ký đăng nhập: IP khách tin được, hoặc IP peer khi không tin được (một xô chung).
 * KHÔNG dùng giá trị này để so IP văn phòng khi `loginClientIpTrusted(req)` là false.
 */
export function extractLoginClientIp(req: Request): string | null {
  return resolveClientIp(req).rateKey
}

/** IP khách có tin được để so với IP văn phòng không (false ⇒ kiểm Wi-Fi cho qua + cảnh báo cấu hình). */
export function loginClientIpTrusted(req: Request): boolean {
  return resolveClientIp(req).ip !== null
}

export function normalizeLoginIp(raw: string): string {
  return raw.trim().replace(/^::ffff:/i, '')
}

/**
 * IP loopback/không xác định (`127.0.0.1`, `::1`, `0.0.0.0`, `unknown`) KHÔNG
 * PHẢI là "IP văn phòng sai" — nó là dấu hiệu KHÔNG LẤY ĐƯỢC IP THẬT (TRUSTED_PROXY
 * chưa khớp proxy phía trước). Lớp chặn thứ hai sau `loginClientIpTrusted`. Coi các giá trị này như
 * "không xác định được IP" → fail-open, KHÔNG so khớp rồi chặn — tránh kịch bản
 * 1 thay đổi hạ tầng ngoài code này (reverse proxy) âm thầm biến `ipAddress` thành
 * loopback cho MỌI request, khiến TOÀN BỘ nhân viên (trừ super_admin) bị chặn
 * cùng lúc mà không ai sửa được từ code.
 */
export function isUnusableLoginIp(ip: string | null | undefined): boolean {
  if (!ip) return true
  const normalized = normalizeLoginIp(ip).toLowerCase()
  if (!normalized) return true
  if (normalized === '::1' || normalized === '0.0.0.0' || normalized === 'unknown') return true
  return normalized.startsWith('127.')
}

/** Master kill-switch — mặc định TẮT (env không set hoặc khác `'true'` = tắt). */
export function isLoginWifiCheckEnabled(): boolean {
  return process.env.LOGIN_WIFI_CHECK_ENABLED === 'true'
}

/**
 * Bypass theo QUYỀN `settings.integrations` (nhóm Hệ thống — chính quyền dùng để
 * bật/tắt CÔNG TẮC này ở `PATCH /auth/settings/login-wifi-check`). Quản trị
 * (`isAdmin`) tự động thoả điều kiện này (mọi quyền = `true`/`'all'`), nên KHÔNG
 * cần nhánh riêng — giữ bất biến "ai bật/tắt được công tắc thì luôn tự vào được,
 * không tự khoá chân mình".
 *
 * Cộng thêm danh sách bypass qua ENV `LOGIN_WIFI_CHECK_BYPASS_EMAILS` (CSV email
 * hoặc user id, KHÔNG hardcode tài khoản cụ thể trong code).
 */
export function isLoginWifiCheckBypassed(user: {
  id: number
  email: string
  grants: Grants
}): boolean {
  if (can(user.grants, 'settings.integrations')) return true

  const raw = process.env.LOGIN_WIFI_CHECK_BYPASS_EMAILS ?? ''
  const list = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  if (list.length === 0) return false

  return list.includes(user.email.toLowerCase()) || list.includes(String(user.id))
}

/** Khớp IP đã chuẩn hoá với danh sách IP văn phòng. */
export function loginIpMatchesOffice(clientIp: string, officeIps: string[]): boolean {
  const normalized = normalizeLoginIp(clientIp)
  return officeIps.map(normalizeLoginIp).includes(normalized)
}
