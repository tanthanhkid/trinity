import type { AttendanceRequest, AttendanceRequestConfig, AttendanceRequestType } from "@/hooks/use-attendance"

/** Nhóm hạn mức tháng của một loại đơn (khớp cấu hình `request-config` của máy chủ). */
export type QuotaGroup = "forgot" | "late_early" | "none"

export function quotaGroupOf(type: AttendanceRequestType): QuotaGroup {
  if (type === "forgot_check_in" || type === "forgot_check_out") return "forgot"
  if (type === "late_arrival" || type === "early_leave") return "late_early"
  return "none"
}

export const QUOTA_GROUP_LABEL: Record<QuotaGroup, string> = {
  forgot: "Quên chấm",
  late_early: "Đến muộn / Về sớm",
  none: "Nghỉ phép / Thai sản",
}

export interface QuotaInfo {
  group: QuotaGroup
  label: string
  /** Số đơn đang giữ chỗ hạn mức (chờ duyệt + đã duyệt, cùng nhóm, cùng tháng) — KHÔNG tính chính đơn đang xem. */
  used: number
  /** Hạn mức tháng; null = không có hạn mức theo đơn (hoặc 0 = không giới hạn). */
  max: number | null
  pct: number
  over: boolean
}

type QuotaRow = Pick<AttendanceRequest, "id" | "user_id" | "type" | "work_date" | "status">

/**
 * Hạn mức tháng của một nhân viên cho nhóm đơn `group` trong tháng `month` (YYYY-MM), đếm trên danh sách đơn đã tải.
 * Khớp máy chủ (`assert_monthly_limit`): đơn chờ duyệt và đã duyệt tính, đơn bị từ chối không tính; hạn mức ≤ 0 = không giới hạn.
 */
export function quotaFor(
  userId: number,
  group: QuotaGroup,
  month: string,
  all: ReadonlyArray<QuotaRow>,
  config: AttendanceRequestConfig | undefined,
  excludeId?: number,
): QuotaInfo {
  const label = QUOTA_GROUP_LABEL[group]
  const limit =
    group === "forgot" ? config?.monthly_forgot_limit : group === "late_early" ? config?.monthly_late_early_limit : undefined
  if (group === "none" || limit === undefined || limit <= 0) {
    return { group, label, used: 0, max: null, pct: 0, over: false }
  }
  const used = all.filter(
    (r) =>
      r.id !== excludeId &&
      r.user_id === userId &&
      r.status !== "rejected" &&
      quotaGroupOf(r.type) === group &&
      r.work_date.slice(0, 7) === month,
  ).length
  return { group, label, used, max: limit, pct: Math.min(100, Math.round((used / limit) * 100)), over: used >= limit }
}

/** Hạn mức tháng của nhân viên gửi đơn `req` (không tính chính `req`). */
export function computeQuota(
  req: Pick<AttendanceRequest, "id" | "user_id" | "type" | "work_date">,
  all: ReadonlyArray<QuotaRow>,
  config: AttendanceRequestConfig | undefined,
): QuotaInfo {
  return quotaFor(req.user_id, quotaGroupOf(req.type), req.work_date.slice(0, 7), all, config, req.id)
}

/** Chữ cái đầu hai từ cuối của tên (thiết kế: "Nguyễn Thị Lan" → "TL"). */
export function nameInitials(name: string | null | undefined): string {
  const w = (name ?? "").trim().split(/\s+/).filter(Boolean)
  if (w.length === 0) return "?"
  if (w.length === 1) return w[0].slice(0, 2).toUpperCase()
  return (w[w.length - 2][0] + w[w.length - 1][0]).toUpperCase()
}

/** Giờ HH:MM từ chuỗi giờ đề nghị (BE trả "HH:MM" hoặc "HH:MM:SS"); rỗng → null. */
export function shortTime(v: string | null | undefined): string | null {
  if (!v) return null
  const m = /^(\d{1,2}):(\d{2})/.exec(v)
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : v
}

/** Nhãn ô «xin bổ sung / xin về lúc / xin đến lúc» trên khối nhấn + giờ đề nghị tương ứng; null nếu đơn không có giờ. */
export function askOf(
  req: Pick<AttendanceRequest, "type" | "requested_check_in" | "requested_check_out">,
): { label: string; time: string } | null {
  const ci = shortTime(req.requested_check_in)
  const co = shortTime(req.requested_check_out)
  switch (req.type) {
    case "forgot_check_in":
      return ci ? { label: "Xin bổ sung giờ vào", time: ci } : null
    case "forgot_check_out":
      return co ? { label: "Xin bổ sung giờ ra", time: co } : null
    case "early_leave":
      return co ? { label: "Xin về lúc", time: co } : null
    case "late_arrival":
      return ci ? { label: "Xin đến lúc", time: ci } : null
    default:
      return null
  }
}

export type RequestStatus = AttendanceRequest["status"]

export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  pending: "Chờ duyệt",
  approved: "Đã duyệt",
  rejected: "Từ chối",
}
