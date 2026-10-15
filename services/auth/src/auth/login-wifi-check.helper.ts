import type { Request } from 'express'
import { can, type Grants } from '@trinity/rbac'

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
 * Gate này so IP client với IP văn phòng, nên chỉ hợp lệ khi `x-real-ip` do reverse
 * proxy đặt là IP thật của client. Nếu hệ thống nằm sau CDN/proxy khác (vd Cloudflare),
 * `x-real-ip` là IP của lớp proxy đó → gate không bao giờ khớp. Khi đó đặt
 * `LOGIN_WIFI_TRUST_CF_IP=true` để đọc `cf-connecting-ip` — chỉ bật khi thật sự nằm
 * sau Cloudflare.
 */

/**
 * Lấy IP client để check wifi lúc login.
 *
 * Tương đương `extractClientIp` của module chấm công của CRM — Auth là service
 * NestJS riêng (build/deploy độc lập, không import chéo giữa services) nên
 * duplicate có chú thích; đồng bộ tay nếu logic gốc đổi thứ tự ưu tiên.
 *
 * ⚠️ Auth service KHÔNG set `app.set('trust proxy', ...)` → Express
 * `req.ip`/`req.socket.remoteAddress` LUÔN là IP của reverse proxy (loopback,
 * vd 127.0.0.1), không phải IP thật của client. PHẢI đọc trực tiếp header
 * `x-real-ip` do reverse proxy đặt (`proxy_set_header X-Real-IP $remote_addr`) —
 * đây là nguồn chính khi không qua Cloudflare.
 *
 * ⚠️ BẢO MẬT — vì sao `cf-connecting-ip` phải sau CỜ ENV, KHÔNG đọc vô điều kiện:
 * header này chỉ đáng tin khi request THỰC SỰ đi qua Cloudflare. Nếu không qua
 * Cloudflare, client TỰ GỬI được `cf-connecting-ip: <IP văn phòng>` → giả mạo
 * đứng trong văn phòng, vô hiệu hoá toàn bộ gate. Vì vậy `LOGIN_WIFI_TRUST_CF_IP`
 * CHỈ được bật ở môi trường thật sự nằm sau Cloudflare. Cờ này TÁCH RIÊNG với
 * `ATTENDANCE_TRUST_CF_IP` của chấm công để bật gate login không kéo theo đổi
 * hành vi chấm công.
 */
/** Loopback / mạng riêng / link-local / ULA — địa chỉ của reverse proxy nội bộ. */
function isPrivateOrLoopbackIp(raw: string | undefined | null): boolean {
  if (!raw) return false
  const ip = normalizeLoginIp(raw).toLowerCase()
  if (ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:')) return true
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

/**
 * Chỉ tin `x-real-ip`/`x-forwarded-for` khi socket tới từ proxy nội bộ (loopback/mạng riêng) hoặc
 * khi vận hành đặt `LOGIN_WIFI_TRUST_PROXY_HEADERS=true`. Gọi thẳng từ Internet thì client tự
 * gửi header được → bỏ qua, dùng IP socket.
 */
function trustsProxyHeaders(req: Request): boolean {
  if (process.env.LOGIN_WIFI_TRUST_PROXY_HEADERS === 'true') return true
  const remote = (req.socket as { remoteAddress?: string })?.remoteAddress
  return isPrivateOrLoopbackIp(remote)
}

export function extractLoginClientIp(req: Request): string | null {
  if (process.env.LOGIN_WIFI_TRUST_CF_IP === 'true') {
    const cf = req.headers['cf-connecting-ip']
    if (typeof cf === 'string' && cf) return normalizeLoginIp(cf)
  }

  if (trustsProxyHeaders(req)) {
    const real = req.headers['x-real-ip']
    if (typeof real === 'string' && real) return normalizeLoginIp(real)

    const forwarded = req.headers['x-forwarded-for']
    if (typeof forwarded === 'string' && forwarded) {
      // Proxy tin cậy APPEND vào cuối chứ không thay entry đầu → entry đầu là phần client tự khai
      // (giả được IP văn phòng). Đi từ phải sang, bỏ các hop proxy nội bộ, lấy IP công cộng
      // ngoài cùng; toàn bộ là IP riêng (client trong LAN) thì dùng entry đầu như trước.
      const hops = forwarded.split(',').map((h) => h.trim()).filter(Boolean)
      const client = [...hops].reverse().find((h) => !isPrivateOrLoopbackIp(h)) ?? hops[0]
      if (client) return normalizeLoginIp(client)
    }
  }

  const remote = (req.socket as { remoteAddress?: string })?.remoteAddress
  if (remote) return normalizeLoginIp(remote)

  if (req.ip) return normalizeLoginIp(req.ip)

  return null
}

export function normalizeLoginIp(raw: string): string {
  return raw.trim().replace(/^::ffff:/i, '')
}

/**
 * IP loopback/không xác định (`127.0.0.1`, `::1`, `0.0.0.0`, `unknown`) KHÔNG
 * PHẢI là "IP văn phòng sai" — nó là dấu hiệu KHÔNG LẤY ĐƯỢC IP THẬT (vd reverse
 * proxy thiếu `proxy_set_header X-Real-IP`, hoặc request đi qua 1 proxy nội bộ
 * khác trước khi tới Auth service). Coi các giá trị này như
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
