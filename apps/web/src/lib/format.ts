export function formatCurrency(amount: number | null | undefined): string {
  // Chuẩn hoà: trả "0" khi giá trị không hợp lệ
  const n = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0
  return n.toLocaleString('vi-VN')
}

/**
 * Back-compat alias: hiển thị FULL số, không rút gọn ("1.6 tỷ"/"470tr").
 */
export function formatCurrencyShort(amount: number | null | undefined): string {
  return formatCurrency(amount)
}

/**
 * Ngày hôm nay theo giờ VN (Asia/Ho_Chi_Minh), format `YYYY-MM-DD`.
 * KHÔNG dùng `new Date().toISOString().slice(0,10)` vì lệch 1 ngày lúc 00:00-06:59 VN (UTC vẫn hôm trước).
 */
export function todayVn(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

/**
 * Trả `YYYY-MM-DD` của MỘT THỜI ĐIỂM BẤT KỲ theo giờ VN (Asia/Ho_Chi_Minh) —
 * dùng để so sánh "có cùng ngày lịch VN hay không" (vd gộp nhóm tin nhắn theo
 * ngày). Khác `todayVn()` (chỉ trả ngày HÔM NAY, không nhận input).
 * KHÔNG dùng `d.toDateString()`/`getDate()` — timezone máy client có thể khác
 * +07 (đã gặp máy set UTC), lệch ngày quanh mốc 00:00-06:59 giờ VN.
 * Trả "" khi input rỗng/invalid.
 */
export function vnDateKey(date: Date | string | null | undefined): string {
  if (date === null || date === undefined || date === '') return ''
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

/**
 * Trả ngày đầu tháng hiện tại theo giờ VN, format `YYYY-MM-DD`.
 * Ví dụ: tháng 6/2026 → "2026-06-01".
 */
export function firstDayOfMonthVn(): string {
  const now = new Date()
  // Lấy năm + tháng VN, rồi tạo ngày 1 của tháng đó
  const vnFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
  })
  const parts = vnFormatter.formatToParts(now)
  const year = parts.find((p) => p.type === 'year')?.value ?? ''
  const month = parts.find((p) => p.type === 'month')?.value ?? ''
  return `${year}-${month}-01`
}

/**
 * Trả ngày cuối tháng hiện tại theo giờ VN, format `YYYY-MM-DD`.
 * Ví dụ: tháng 6/2026 → "2026-06-30"; tháng 2/2024 (nhuận) → "2024-02-29".
 * Dùng kỹ thuật "ngày 0 của tháng kế tiếp" để tự xử lý số ngày mỗi tháng.
 */
export function lastDayOfMonthVn(): string {
  const now = new Date()
  const vnFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
  })
  const parts = vnFormatter.formatToParts(now)
  const year = Number(parts.find((p) => p.type === 'year')?.value ?? '0')
  const month = Number(parts.find((p) => p.type === 'month')?.value ?? '0')
  // Ngày 0 của tháng (month+1) = ngày cuối của tháng month
  const lastDay = new Date(year, month, 0).getDate()
  const mm = String(month).padStart(2, '0')
  const dd = String(lastDay).padStart(2, '0')
  return `${year}-${mm}-${dd}`
}

/**
 * Trả ngày N ngày trước (tính theo giờ VN), format `YYYY-MM-DD`.
 * Dùng để set default range filter: `nDaysAgoVn(7)` → từ 7 ngày trước đến hôm nay.
 */
export function nDaysAgoVn(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

/**
 * Convert ISO `YYYY-MM-DD` → VN display `DD/MM/YYYY`.
 * Trả "" khi input rỗng/invalid để input field không hiển nhãn rác.
 * KHÔNG parse qua `new Date()` để tránh DST/timezone shift — chỉ split + reorder.
 */
export function isoToVnDate(iso: string | null | undefined): string {
  if (!iso) return ""
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return ""
  return `${m[3]}/${m[2]}/${m[1]}`
}

/**
 * Parse VN-format `DD/MM/YYYY` → ISO `YYYY-MM-DD`.
 * Trả "" nếu chưa đủ ký tự, undefined nếu format SAI (hợp lệ partial vs invalid khác nhau).
 * Validate ngày-tháng-năm thực: 31/02 → undefined, 29/02/2024 → ok.
 */
export function parseVnDate(vn: string): string | undefined {
  const trimmed = vn.trim()
  if (!trimmed) return ""
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed)
  if (!m) return undefined
  const day = Number(m[1])
  const month = Number(m[2])
  const year = Number(m[3])
  if (year < 1900 || year > 2999) return undefined
  if (month < 1 || month > 12) return undefined
  const lastDay = new Date(year, month, 0).getDate()
  if (day < 1 || day > lastDay) return undefined
  return `${m[3]}-${m[2]}-${m[1]}`
}

/**
 * Auto-mask khi user gõ: chèn `/` sau 2 và 4 digits. Strip mọi ký tự không phải số.
 * Cap tối đa 8 digits (DDMMYYYY) để tránh chuỗi dài vô nghĩa.
 *
 * Có 2 luồng xử lý:
 *
 * A) **Gõ từng chữ số / paste không dấu** (raw không có sẵn dấu `/`):
 *    Strip ký tự không phải số → tái tạo mask DD/MM/YYYY.
 *
 * B) **Chỉnh sửa trực tiếp** (raw đã có cấu trúc với dấu `/`):
 *    Giữ nguyên 3 phần, chỉ clamp mỗi phần đến 2/2/4 chữ số. KHÔNG padStart.
 *    Lý do: "15/0/2026" = user đang gõ dở tháng "0→03", nếu pad "0"→"00" thì
 *    user sẽ không thể gõ "03" được nữa vì cursor kẹt sau 10 ký tự. Tránh bug reset "00".
 *    Hệ quả: paste "1/5/2026" hiển thị "1/5/2026" thay vì "01/05/2026" — user vẫn
 *    có thể hoàn thiện, và parseVnDate sẽ reject cho đến khi đủ 2+2+4 chữ số.
 */
export function autoMaskVnDate(raw: string): string {
  if (raw.includes("/")) {
    const parts = raw.split("/")
    if (parts.length === 3) {
      const [dd, mm, yyyy] = parts
      const ddDigits = dd.replace(/\D/g, "").slice(0, 2)
      const mmDigits = mm.replace(/\D/g, "").slice(0, 2)
      const yyyyDigits = yyyy.replace(/\D/g, "").slice(0, 4)
      // Giữ cấu trúc 3 phần, không pad — tránh bug "00" khi user gõ dở
      if (yyyyDigits.length > 0) return `${ddDigits}/${mmDigits}/${yyyyDigits}`
      if (ddDigits.length > 0 || mmDigits.length > 0) return `${ddDigits}/${mmDigits}`
    }
  }
  const digits = raw.replace(/\D/g, "").slice(0, 8)
  if (digits.length <= 2) return digits
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`
}

/**
 * Hiển thị field hạt-THÁNG `YYYY-MM` dưới dạng `DD/MM/YYYY` (ngày auto = 01).
 * Dùng cho "Thành phần lương": hiệu lực lưu theo tháng nhưng hiển thị dd/MM/yyyy.
 * Trả "" nếu input rỗng/không hợp lệ.
 */
export function monthToVnDate(ym: string | null | undefined): string {
  if (!ym) return ""
  const m = /^(\d{4})-(\d{2})$/.exec(ym)
  if (!m) return ""
  return `01/${m[2]}/${m[1]}`
}

export function formatDate(date: Date | string | null | undefined): string {
  if (date === null || date === undefined || date === '') return '—'
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' })
}

export function formatDateTime(date: Date | string | null | undefined): string {
  if (date === null || date === undefined || date === '') return '—'
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * Thời gian kèm GIÂY theo giờ VN — dùng cho log chi tiết.
 * Trả "HH:mm:ss DD/MM/YYYY" — deterministic (Intl.DateTimeFormat, không dùng toLocaleString không có options).
 * Ví dụ: "09:05:37 04/06/2026".
 */
export function formatDateTimeVn(date: Date | string | null | undefined): string {
  if (date === null || date === undefined || date === '') return '—'
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return '—'
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour12: false,
  })
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]))
  return `${p.hour}:${p.minute}:${p.second} ${p.day}/${p.month}/${p.year}`
}

/**
 * Giờ:phút theo giờ VN — dùng cho bubble tin nhắn trong hội
 * thoại. KHÔNG dùng `new Date().toLocaleTimeString()` không tham số
 * timezone (đọc theo múi giờ TRÌNH DUYỆT, có thể khác +07 — máy set UTC sẽ
 * hiện sai giờ tin nhắn, chưa kể lệch NGÀY quanh mốc 00:00-06:59 giờ VN).
 * Trả "" khi input rỗng/invalid (caller tự fallback nếu cần).
 */
export function formatTimeVn(date: Date | string | null | undefined): string {
  if (date === null || date === undefined || date === '') return ''
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]))
  return `${p.hour}:${p.minute}`
}

/**
 * Chuẩn hoá giá trị birthday từ backend thành chuỗi YYYY-MM-DD (input type=date).
 * Backend có thể trả Date object, ISO string, hoặc null. Frontend từng giả định
 * luôn là string và crash khi gặp Date (".split is not a function").
 */
export function formatBirthday(value: Date | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return ''
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return ''
    return value.toISOString().slice(0, 10)
  }
  if (typeof value === 'string') {
    return value.slice(0, 10)
  }
  return ''
}

/**
 * Số ngày kể từ một thời điểm. Trả về null khi input không hợp lệ để UI tự render placeholder.
 */
export function daysSince(date: Date | string | null | undefined): number | null {
  if (date === null || date === undefined || date === '') return null
  const d = date instanceof Date ? date : new Date(date)
  const t = d.getTime()
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000))
}

/**
 * Trả về chuỗi `NV #N` khi id hợp lệ (> 0), ngược lại null để caller fallback.
 * Guard tránh case id=0 (fallback value của backend) hoặc NaN.
 */
function formatEmployeeIdFallback(
  id: number | string | null | undefined,
): string | null {
  if (id === null || id === undefined || id === '') return null
  const idNum = typeof id === 'number' ? id : parseInt(id, 10)
  if (!Number.isFinite(idNum) || idNum <= 0) return null
  return `NV #${idNum}`
}

/**
 * Hiển thị nhân viên ở các chỗ read-only (bảng, timeline, detail, badge...).
 * Ưu tiên họ tên để dễ đọc trên UI; email chỉ dùng làm fallback cuối.
 * Fallback: full_name → email → "NV #id" (chỉ khi id>0) → "—".
 */
export function formatEmployee(
  user:
    | { email?: string | null; full_name?: string | null; id?: number | string | null }
    | null
    | undefined,
): string {
  if (!user) return '—'
  if (user.full_name) return user.full_name
  if (user.email) return user.email
  return formatEmployeeIdFallback(user.id) ?? '—'
}

/**
 * Hiển thị nhân viên trong combobox/select tìm kiếm: "Họ tên (email)".
 * Khi chỉ có 1 trong 2, fallback về thứ còn lại.
 */
export function formatEmployeeOption(
  user:
    | { email?: string | null; full_name?: string | null; id?: number | string | null }
    | null
    | undefined,
): string {
  if (!user) return '—'
  if (user.full_name && user.email) return `${user.full_name} (${user.email})`
  if (user.full_name) return user.full_name
  if (user.email) return user.email
  return formatEmployeeIdFallback(user.id) ?? '—'
}

/**
 * Chuẩn hoá SĐT Việt Nam về định dạng nội địa `0xxx` để HIỂN THỊ — nghịch đảo
 * (số nguồn có thể ở dạng `84xxxxxxxxx`).
 *
 * Chuẩn hoá hiển thị về `0xxx` cho đồng nhất với Danh bạ (luôn lưu/hiện `0xxx`).
 *
 * Idempotent với `0xxx`. Trả về digits đã làm sạch nếu không khớp mẫu VN (số
 * 12 chữ số `84xxxxxxxxxx`, quốc tế... giữ nguyên — `formatPhone`
 * fallback về chuỗi gốc).
 *
 * ⚠️ GIỮ ĐỒNG BỘ với `normalizePhone` trong `packages/utils/src/index.ts` (logic
 * giống hệt, kể cả regex đầu số mobile `[35789]`). `apps/web` không depend
 * `@trinity/utils` nên phải copy — đổi đầu số mobile thì sửa CẢ HAI nơi.
 */
export function toLocalPhone(phone: string): string {
  const cleaned = phone.replace(/\D/g, '')
  // 84xxxxxxxxx (11 chữ số) → 0xxxxxxxxx
  if (cleaned.startsWith('84') && cleaned.length === 11) {
    return '0' + cleaned.slice(2)
  }
  // 0xxxxxxxxx (10 chữ số) — đã chuẩn
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    return cleaned
  }
  // Excel hay drop leading 0: 9 chữ số đầu mobile VN (3/5/7/8/9) → thêm '0'
  if (cleaned.length === 9 && /^[35789]/.test(cleaned)) {
    return '0' + cleaned
  }
  return cleaned
}

export function formatPhone(phone: string | null | undefined): string {
  if (!phone) return ''
  const local = toLocalPhone(phone)
  if (local.length === 10) {
    return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`
  }
  return phone
}

// Spec: xxx-xxx-**67 (3 x + '-' + 3 x + '-' + ** + 2 chữ số cuối)
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return ''
  const cleaned = phone.replace(/\D/g, '')
  if (cleaned.length >= 2) {
    return `xxx-xxx-**${cleaned.slice(-2)}`
  }
  return 'xxx-xxx-**'
}

// RBAC quyền + phạm vi: KHÔNG set vai trò dùng chung để che/hiện SĐT. Mỗi màn có quyền riêng trong `@trinity/rbac`
// (`contacts.phone_full`, `users.phone_full`) — caller truyền `canSeeFull` đọc từ `usePermissions()`.

// SĐT ở Danh bạ (danh sách + chi tiết) hiển thị ĐÚNG chuỗi BE trả
// (BE che theo `contacts.phone_full` + phạm vi).
