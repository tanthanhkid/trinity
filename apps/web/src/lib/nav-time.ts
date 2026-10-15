import { formatDate } from "@/lib/format"

/**
 * "N phút"/"N giờ"/"Hôm qua"/ngày cụ thể — dùng cho "Khách gần đây" ở sidebar.
 * `lib/format.ts` chỉ có absolute date/time, không có "time ago"
 * nên viết mới ở đây — theo giờ VN (Asia/Ho_Chi_Minh), KHÔNG `toLocaleString`
 * trần.
 */
export function formatRelativeTimeVn(iso: string | null | undefined): string {
  if (!iso) return ""
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""

  const now = Date.now()
  const diffMs = now - date.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return "Vừa xong"
  if (diffMin < 60) return `${diffMin} phút`

  const diffHour = Math.floor(diffMin / 60)
  // So NGÀY theo giờ VN (không phải cắt 24h tròn) — so ngày theo giờ VN, khớp lịch
  const vnDateKey = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(d)
  const todayKey = vnDateKey(new Date(now))
  const dateKey = vnDateKey(date)
  if (dateKey === todayKey) return diffHour < 1 ? `${diffMin} phút` : `${diffHour} giờ`

  const yesterdayKey = vnDateKey(new Date(now - 86_400_000))
  if (dateKey === yesterdayKey) return "Hôm qua"

  return formatDate(iso)
}
