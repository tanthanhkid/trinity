/** Tệp CSV mẫu cho "Nhập nhiều bài từ CSV" — dựng ở trình duyệt, tiêu đề tiếng Việt khớp bí danh của máy chủ. */
export const CSV_TEMPLATE_HEADER = ["noi_dung", "kenh", "gio_dang", "tep", "binh_luan_dau", "tieu_de_youtube", "utm"] as const

const pad = (n: number) => String(n).padStart(2, "0")

/** Ô CSV: bọc ngoặc kép khi có dấu phân cách / ngoặc kép / xuống dòng; `"` nhân đôi. */
export function csvCell(v: string): string {
  // Ô bắt đầu bằng = + - @ (vd tên Page lấy từ mạng xã hội) thì Excel hiểu là công thức ⇒ thêm ' phía trước.
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
  return /[",;\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** "YYYY-MM-DD HH:mm" giờ Việt Nam của `now` + `days` ngày. */
function vnTime(now: Date, days: number, hhmm: string): string {
  const vn = new Date(now.getTime() + 7 * 3_600_000 + days * 86_400_000)
  return `${vn.getUTCFullYear()}-${pad(vn.getUTCMonth() + 1)}-${pad(vn.getUTCDate())} ${hhmm}`
}

/** Mẫu 2 dòng: dòng 1 hẹn giờ cụ thể, dòng 2 vào hàng đợi. Có tên kênh của người dùng thì điền vào cột kênh. Có BOM để Excel đọc đúng tiếng Việt. */
export function buildCsvTemplate(channelNames: string[], now = new Date()): string {
  const [a, b] = [channelNames[0] ?? "Tên kênh", channelNames[1] ?? channelNames[0] ?? "Tên kênh"]
  const rows = [
    [...CSV_TEMPLATE_HEADER],
    ["Khai trương chi nhánh mới — mời cả nhà ghé chơi!", a, vnTime(now, 2, "09:00"), "", "Địa chỉ: 12 Nguyễn Huệ, Q.1", "", "khai-truong"],
    ["Mẹo nhỏ cuối tuần cho khách quen.", `${a}; ${b}`, "hàng đợi", "", "", "", ""],
  ]
  return `﻿${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`
}
