/**
 * Ngày giờ của trường `datetime`: BE lưu ISO UTC; `VnDateTimeInput` làm việc với chuỗi
 * "YYYY-MM-DDTHH:mm" theo GIỜ VIỆT NAM (UTC+7, không DST). Hai hàm đổi qua lại — không phụ thuộc múi giờ máy.
 */
const VN_OFFSET_MS = 7 * 3_600_000

export function isoToVnLocal(iso: unknown): string {
  if (typeof iso !== "string") return ""
  const t = Date.parse(iso)
  return Number.isFinite(t) ? new Date(t + VN_OFFSET_MS).toISOString().slice(0, 16) : ""
}

export function vnLocalToIso(local: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return undefined
  const t = Date.parse(`${local}:00.000Z`) - VN_OFFSET_MS
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined
}
