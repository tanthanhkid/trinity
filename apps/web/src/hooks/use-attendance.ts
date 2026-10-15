"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import { usePermissions } from "@/lib/rbac"
import { readUiPref } from "@/lib/ui-pref-storage"

export type AttendanceStatusValue =
  | "incomplete"
  | "present"
  | "late"
  | "half_day"
  | string

export interface AttendanceRecordUser {
  id: number
  full_name: string
  email: string | null
  employee?: {
    position: string | null
    /** Team CHÍNH THỨC resolve 3 tầng — null = "Chưa gán Team". */
    team_name?: string | null
    /** employees.department raw — null = "Chưa phân phòng". */
    department?: string | null
  } | null
}

export interface AttendanceRecord {
  id: number
  user_id: number
  employee_id: number | null
  work_date: string
  check_in_at: string | null
  check_out_at: string | null
  check_in_ip: string | null
  check_out_ip: string | null
  device_id: string | null
  check_in_note: string | null
  check_out_note: string | null
  // Legacy QR/GPS fields — chỉ còn cho bản ghi cũ (null với bản ghi IP+device mới).
  check_in_lat: number | null
  check_out_lat: number | null
  check_in_lng: number | null
  check_out_lng: number | null
  check_in_proof_key: string | null
  check_out_proof_key: string | null
  total_hours: number | null
  late_minutes: number | null
  /** Phút được hỗ trợ đi muộn — chỉ có trong response chi tiết getRecordById. */
  late_support_minutes?: number | null
  /** Phút đi muộn tính vi phạm = thực tế − hỗ trợ — chỉ có trong response chi tiết. */
  late_violation_minutes?: number | null
  /** Tên văn phòng nơi chấm công vào — chỉ có trong response chi tiết getRecordById. */
  check_in_office_name?: string | null
  /** Tên văn phòng nơi chấm công ra — chỉ có trong response chi tiết getRecordById. */
  check_out_office_name?: string | null
  status: AttendanceStatusValue
  created_at: string
  updated_at: string
  user?: AttendanceRecordUser
}

export interface TodaySummaryAdmin {
  work_date: string
  total: number
  checked_in: number
  present: number
  incomplete: number
  absent: number
}

export interface TodaySummarySelf {
  work_date: string
  record: AttendanceRecord | null
}

export interface AttendanceListResult {
  data: AttendanceRecord[]
  pagination: { page: number; page_size: number; total: number; total_pages: number }
}

export interface WeeklyStatDay {
  date: string
  total_hours: number | null
  status: AttendanceStatusValue | null
  check_in_at: string | null
  check_out_at: string | null
}

export interface MonthlyStat {
  month: string
  total_hours: number
  present_days: number
  late_days: number
  half_days: number
  records_count: number
  /** Tổng giờ làm TOÀN BỘ nhân viên trong tháng — chỉ super_admin/quản lý nhân sự (null với role khác). */
  company_total_hours: number | null
}

export interface AttendanceShiftConfig {
  work_start: string
  work_end: string
  late_after: string
  /** Giờ nghỉ trưa — khoảng này rơi vào giờ làm sẽ tự trừ khỏi total_hours. */
  lunch_start: string
  lunch_end: string
  /** Tổng giờ < mức này → "Xem xét" (đỏ). Cấu hình bởi super_admin/quản lý nhân sự. */
  review_max_hours: number
  /** [review_max, half_day_min) → "Chưa đủ nửa ngày"; [half_day_min, full_day_min) → "Nửa ngày". */
  half_day_min_hours: number
  /** Tổng giờ >= mức này → đủ công. */
  full_day_min_hours: number
}

/** Nhân viên VẮNG (chưa chấm vào lẫn ra) trong ngày — hiển thị bảng + xuất Excel. */
export interface AbsentEmployee {
  user_id: number
  employee_code: string
  full_name: string | null
  email: string | null
  phone: string | null
  position: string | null
  department: string | null
  gender: string | null // 'M' | 'F' | null
  office_name: string | null
  team_name: string | null
  team_id: number | null
}

/** Cột sort hợp lệ cho bảng NV vắng (khớp whitelist BE ABSENT_ORDER_COLUMNS). */
export type AbsentSortColumn =
  | "employee_code"
  | "full_name"
  | "email"
  | "phone"
  | "position"
  | "department"
  | "gender"
  | "office_name"
  | "team"

/** Số liệu chấm công cho 1 nhóm (Team/Phòng ban) — đếm theo NGƯỜI distinct. */
export interface GroupStatBase {
  headcount: number
  checked_in_people: number
  present_people: number
  late_people: number
  insufficient_people: number
  absent_people: number
  attendance_rate: number
  total_late_minutes: number
}

export interface TeamStatRow extends GroupStatBase {
  team_id: number | null
  team_name: string
}

export interface DepartmentStatRow extends GroupStatBase {
  department: string
  head_name: string | null
}

export interface AttendanceStats {
  date_from: string
  date_to: string
  total_employees: number
  distinct_checked_in: number
  not_checked_in: number
  summary: {
    checked_in: number
    checked_out: number
    complete: number
    on_time: number
    late: number
    total_late_minutes: number
  }
  daily: Array<{ date: string; checked_in: number; on_time: number; late: number }>
  by_team: TeamStatRow[]
  by_department: DepartmentStatRow[]
  early_leave: EarlyLeaveStats
}

export interface DisciplineAbsentRow {
  user_id: number
  full_name: string | null
  employee_code: string | null
  team_name: string
  position: string | null
  absent_days: number
  absent_occurrences: number
  absent_rate: number
}

export interface DisciplineViolationRow {
  user_id: number
  full_name: string | null
  employee_code: string | null
  team_name: string
  position: string | null
  late_minutes: number
  early_minutes: number
  violation_minutes: number
  late_count: number
  early_count: number
}

export interface DisciplineGenderRow {
  gender: "M" | "F" | "unknown"
  gender_label: string
  headcount: number
  total_absent_days: number
  total_late_count: number
  total_early_count: number
  full_attendance_rate: number
  insufficient_rate: number
}

export interface DisciplineStats {
  date_from: string
  date_to: string
  work_end: string
  total_workdays: number
  top_absent: DisciplineAbsentRow[]
  top_violation: DisciplineViolationRow[]
  by_gender: DisciplineGenderRow[]
}

/** Phân tích nghỉ phép (4 biểu đồ) — khớp BE LeaveAnalytics. */
export interface LeaveTypeSlice {
  type: string
  label: string
  value: number
}
export interface LeaveGenderSlice {
  gender: "M" | "F" | "unknown"
  label: string
  value: number
}
export interface LeaveWeekBucket {
  label: string
  from: string
  to: string
}
export interface LeaveDeptSeries {
  department: string
  values: number[]
}
export interface LeaveAnalytics {
  date_from: string
  date_to: string
  by_type_days: LeaveTypeSlice[]
  by_type_requests: LeaveTypeSlice[]
  by_week: { weeks: LeaveWeekBucket[]; departments: LeaveDeptSeries[] }
  by_gender: LeaveGenderSlice[]
}

/** Số liệu "Về sớm" — đơn early_leave + phút thiếu giờ + top NV về sớm. */
export interface EarlyLeaveStats {
  total: number
  approved: number
  rejected: number
  pending: number
  total_minutes: number
  approval_rate: number
  top_leavers: Array<{
    user_id: number
    full_name: string | null
    count: number
    minutes: number
  }>
}

/** Tuỳ chọn 3 bộ lọc multi-select trong popup Thống kê. */
export interface StatsFilterOptions {
  departments: string[]
  teams: { id: number; name: string }[]
  offices: { id: number; name: string }[]
}

/** Giá trị 3 bộ lọc đang chọn (rỗng = xem tất cả). */
export interface StatsFilter {
  department: string[]
  team_id: number[]
  office_id: number[]
}

/** Kết quả endpoint /absent — danh sách NV vắng cho 1 ngày tùy chọn. */
export interface AbsentSummary {
  absent_date: string
  absent_employees: AbsentEmployee[]
}

export interface AttendanceOffice {
  id: number
  name: string
  description: string | null
  ips: string[]
  is_active: boolean
  is_demo: boolean
  created_at: string
  updated_at: string
}

export interface CheckResult {
  record: AttendanceRecord
  already: boolean
  office: string
}

const KEY = "attendance"

/** `crypto.randomUUID` chỉ có ở secure context (https/localhost) — http nội bộ thì rơi về getRandomValues. */
function generateUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** Device token ổn định cho mỗi trình duyệt — sinh 1 lần, lưu localStorage. */
export function getOrCreateDeviceId(): string {
  const STORAGE_KEY = "trinity-attendance-device-id"
  if (typeof window === "undefined") return ""
  try {
    let id = readUiPref(STORAGE_KEY)
    if (!id) {
      id = generateUuid()
      window.localStorage.setItem(STORAGE_KEY, id)
    }
    return id
  } catch {
    return ""
  }
}

function invalidateAttendance(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: [KEY, "today"] })
  qc.invalidateQueries({ queryKey: [KEY, "list"] })
  qc.invalidateQueries({ queryKey: [KEY, "weekly"] })
  qc.invalidateQueries({ queryKey: [KEY, "monthly"] })
}

/** Chấm công vào — gửi device_id + ảnh selfie (bắt buộc) qua multipart/form-data. */
export function useCheckIn() {
  const qc = useQueryClient()
  return useMutation<CheckResult, unknown, Blob>({
    mutationFn: (selfie) => {
      const fd = new FormData()
      fd.append("device_id", getOrCreateDeviceId())
      fd.append("selfie", selfie, "selfie.jpg")
      // PHẢI override Content-Type — nếu để default 'application/json' axios sẽ serialize
      // FormData thành JSON → BE FileInterceptor không nhận file (gotcha).
      return apiClient
        .post("/management/attendance/check-in", fd, {
          headers: { "Content-Type": "multipart/form-data" },
        })
        .then((r) => r.data)
    },
    onSuccess: () => invalidateAttendance(qc),
  })
}

/** Chấm công ra — gửi device_id + ảnh selfie (bắt buộc) qua multipart/form-data. */
export function useCheckOut() {
  const qc = useQueryClient()
  return useMutation<CheckResult, unknown, Blob>({
    mutationFn: (selfie) => {
      const fd = new FormData()
      fd.append("device_id", getOrCreateDeviceId())
      fd.append("selfie", selfie, "selfie.jpg")
      return apiClient
        .post("/management/attendance/check-out", fd, {
          headers: { "Content-Type": "multipart/form-data" },
        })
        .then((r) => r.data)
    },
    onSuccess: () => invalidateAttendance(qc),
  })
}

export function useTodaySummary(date?: string) {
  return useQuery<TodaySummaryAdmin | TodaySummarySelf>({
    // Theo NGÀY đang lọc (mặc định hôm nay) — để thanh tóm tắt khớp Sổ chấm công bên dưới.
    queryKey: [KEY, "today", date ?? null],
    queryFn: () =>
      apiClient
        .get("/management/attendance/today", {
          params: date ? { date } : undefined,
        })
        .then((r) => r.data),
    staleTime: 30_000,
  })
}

export interface AttendanceListParams {
  date_from?: string
  date_to?: string
  user_id?: number
  page: number
  page_size?: number
  /** Cột sắp xếp: work_date | employee | check_in (mặc định) | check_out | total_hours | status | org (sơ đồ tổ chức) */
  sort_by?: string
  /** Chiều sắp xếp: asc (mặc định) | desc */
  sort_dir?: string
  /** tìm theo tên nhân viên (ILIKE). */
  search?: string
  /** lọc theo trạng thái (tính lại): present|late|half_day|insufficient|review|incomplete|leave|maternity. */
  status?: string
  /** lọc theo team_id (employees.team_id). */
  team_id?: number
  /** lọc theo phòng ban (employees.department). */
  department?: string
  /** lọc theo chức danh (employees.job_title_id). */
  job_title_id?: number
}

export function useAttendanceList(params: AttendanceListParams) {
  // BE `GET /management/attendance` gate `attendance.view`.
  const { can } = usePermissions()
  return useQuery<AttendanceListResult>({
    enabled: can("attendance.view"),
    queryKey: [KEY, "list", params],
    queryFn: () =>
      apiClient.get("/management/attendance", { params }).then((r) => r.data),
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  })
}

export function useAttendanceDetail(id: number | null) {
  return useQuery<AttendanceRecord>({
    queryKey: [KEY, "detail", id],
    queryFn: () =>
      apiClient.get(`/management/attendance/${id}`).then((r) => r.data),
    enabled: id != null,
  })
}

export function usePatchAttendance(id: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiClient.patch(`/management/attendance/${id}`, body).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY, "detail", id] })
      qc.invalidateQueries({ queryKey: [KEY, "list"] })
      qc.invalidateQueries({ queryKey: [KEY, "today"] })
    },
  })
}

/** Xóa bản ghi chấm công (super_admin + quản lý nhân sự) → nhân viên chấm lại được. */
export function useDeleteAttendance() {
  const qc = useQueryClient()
  return useMutation<{ ok: boolean; id: number }, unknown, number>({
    mutationFn: (id: number) =>
      apiClient.delete(`/management/attendance/${id}`).then((r) => r.data),
    onSuccess: () => invalidateAttendance(qc),
  })
}

export function useWeeklyStats(userId?: number) {
  return useQuery<WeeklyStatDay[]>({
    queryKey: [KEY, "weekly", userId ?? "self"],
    queryFn: () =>
      apiClient
        .get("/management/attendance/stats/weekly", {
          params: userId ? { user_id: userId } : {},
        })
        .then((r) => r.data),
    staleTime: 30_000,
  })
}

/** biểu đồ đường tổng giờ làm 7 ngày — admin = tất cả NV; role khác = cá nhân. */
export interface WeeklyHoursChart {
  scope: "all" | "self"
  data: Array<{ date: string; total_hours: number }>
}

export function useWeeklyHoursChart(dateFrom?: string, dateTo?: string) {
  return useQuery<WeeklyHoursChart>({
    queryKey: [KEY, "weekly-hours", dateFrom ?? null, dateTo ?? null],
    queryFn: () =>
      apiClient
        .get("/management/attendance/stats/weekly-hours", {
          params: dateFrom && dateTo ? { date_from: dateFrom, date_to: dateTo } : undefined,
        })
        .then((r) => r.data),
    staleTime: 30_000,
  })
}

export function useMonthlyStats(userId?: number, month?: string) {
  return useQuery<MonthlyStat>({
    queryKey: [KEY, "monthly", userId ?? "self", month ?? "current"],
    queryFn: () =>
      apiClient
        .get("/management/attendance/stats/monthly", {
          params: {
            ...(userId ? { user_id: userId } : {}),
            ...(month ? { month } : {}),
          },
        })
        .then((r) => r.data),
    staleTime: 30_000,
  })
}

export function useAttendanceSettings() {
  return useQuery<AttendanceShiftConfig>({
    queryKey: [KEY, "settings"],
    queryFn: () =>
      apiClient.get("/management/attendance/settings").then((r) => r.data),
    staleTime: 60_000,
  })
}

export function useUpdateAttendanceSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: AttendanceShiftConfig) =>
      apiClient.patch("/management/attendance/settings", body).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY, "settings"] })
      qc.invalidateQueries({ queryKey: [KEY, "list"] })
    },
  })
}

export function useWorkingSaturdays() {
  return useQuery<{ dates: string[] }>({
    queryKey: [KEY, "working-saturdays"],
    queryFn: () =>
      apiClient.get("/management/attendance/working-saturdays").then((r) => r.data),
    staleTime: 60_000,
  })
}

export function useUpdateWorkingSaturdays() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (dates: string[]) =>
      apiClient
        .patch("/management/attendance/working-saturdays", { dates })
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY, "working-saturdays"] })
      qc.invalidateQueries({ queryKey: [KEY, "list"] })
    },
  })
}

const EMPTY_STATS_FILTER: StatsFilter = { department: [], team_id: [], office_id: [] }

/** Param chung cho /stats + 2 endpoint xuất Excel (khoảng ngày + 3 bộ lọc). */
export function buildStatsParams(
  dateFrom: string,
  dateTo: string,
  filter: StatsFilter = EMPTY_STATS_FILTER,
): Record<string, string | string[] | number[]> {
  const params: Record<string, string | string[] | number[]> = {
    date_from: dateFrom,
    date_to: dateTo,
  }
  if (filter.department.length) params.department = filter.department
  if (filter.team_id.length) params.team_id = filter.team_id
  if (filter.office_id.length) params.office_id = filter.office_id
  return params
}

/** Thống kê chấm công tổng hợp (super_admin + quản lý nhân sự) — popup biểu đồ + lọc nhóm. */
export function useAttendanceStats(
  dateFrom: string,
  dateTo: string,
  filter: StatsFilter = EMPTY_STATS_FILTER,
  enabled = true,
) {
  return useQuery<AttendanceStats>({
    queryKey: [KEY, "stats", dateFrom, dateTo, filter],
    queryFn: () =>
      apiClient
        .get("/management/attendance/stats", {
          params: buildStatsParams(dateFrom, dateTo, filter),
        })
        .then((r) => r.data),
    enabled,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  })
}

/** Thống kê kỷ luật (top nghỉ / đi muộn-về sớm / theo giới tính) — popup Thống kê. */
export function useDisciplineStats(
  dateFrom: string,
  dateTo: string,
  filter: StatsFilter = EMPTY_STATS_FILTER,
  enabled = true,
) {
  return useQuery<DisciplineStats>({
    queryKey: [KEY, "discipline", dateFrom, dateTo, filter],
    queryFn: () =>
      apiClient
        .get("/management/attendance/stats/discipline", {
          params: buildStatsParams(dateFrom, dateTo, filter),
        })
        .then((r) => r.data),
    enabled,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  })
}

/** Phân tích nghỉ phép (theo loại / theo tuần × phòng ban / theo giới tính) — popup Thống kê. */
export function useLeaveAnalytics(
  dateFrom: string,
  dateTo: string,
  filter: StatsFilter = EMPTY_STATS_FILTER,
  enabled = true,
) {
  return useQuery<LeaveAnalytics>({
    queryKey: [KEY, "leave-analytics", dateFrom, dateTo, filter],
    queryFn: () =>
      apiClient
        .get("/management/attendance/stats/leave-analytics", {
          params: buildStatsParams(dateFrom, dateTo, filter),
        })
        .then((r) => r.data),
    enabled,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  })
}

/** Tuỳ chọn bộ lọc Phòng ban / Team / Văn phòng cho popup Thống kê. */
export function useStatsFilterOptions(enabled = true) {
  return useQuery<StatsFilterOptions>({
    queryKey: [KEY, "stats", "filters"],
    queryFn: () =>
      apiClient
        .get("/management/attendance/stats/filters")
        .then((r) => r.data),
    enabled,
    staleTime: 60_000,
  })
}

/** Danh sách NV vắng (chưa chấm vào lẫn ra) cho 1 NGÀY tùy chọn — độc lập bộ lọc khoảng.
 *  Sort SERVER-SIDE (sortBy/sortDir) để bảng + Excel khớp tuyệt đối. */
export function useAbsentEmployees(
  date: string,
  sortBy: AbsentSortColumn,
  sortDir: "asc" | "desc",
  enabled = true,
) {
  return useQuery<AbsentSummary>({
    queryKey: [KEY, "absent", date, sortBy, sortDir],
    queryFn: () =>
      apiClient
        .get("/management/attendance/absent", {
          params: { date, sort_by: sortBy, sort_dir: sortDir },
        })
        .then((r) => r.data),
    enabled,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  })
}

// ============================================================
// VĂN PHÒNG (super_admin) — quản lý danh sách IP hợp lệ
// ============================================================

export function useOffices(enabled = true) {
  // BE `/management/attendance/offices` gate `attendance.view`.
  const { can } = usePermissions()
  return useQuery<AttendanceOffice[]>({
    queryKey: [KEY, "offices"],
    queryFn: () =>
      apiClient.get("/management/attendance/offices").then((r) => r.data),
    enabled: enabled && can("attendance.view"),
    staleTime: 60_000,
  })
}

export interface OfficeInput {
  name: string
  description?: string | null
  ips: string[]
  is_active?: boolean
  is_demo?: boolean
}

export function useCreateOffice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: OfficeInput) =>
      apiClient.post("/management/attendance/offices", body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY, "offices"] }),
  })
}

export function useUpdateOffice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: Partial<OfficeInput> }) =>
      apiClient.patch(`/management/attendance/offices/${id}`, body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY, "offices"] }),
  })
}

export function useDeleteOffice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) =>
      apiClient.delete(`/management/attendance/offices/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY, "offices"] }),
  })
}

/** Reset thiết bị đã đăng ký của 1 nhân viên (super_admin) — userId = users.id. */
export function useResetDevice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: number) =>
      apiClient
        .post(`/management/attendance/reset-device/${userId}`)
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["employees"] }),
  })
}

// ============================================================
// ĐƠN CHẤM CÔNG — Request types, config, CRUD + approve/reject
// ============================================================

/** 6 loại đơn chấm công */
export const REQUEST_TYPE_LABEL: Record<string, string> = {
  forgot_check_in: "Quên chấm vào",
  forgot_check_out: "Quên chấm ra",
  late_arrival: "Xin đến muộn",
  // PHẢI khớp BE ATTENDANCE_REQUEST_TYPES (`early_leave`), sai type thì BE trả 400.
  early_leave: "Xin về sớm",
  leave: "Nghỉ phép",
  maternity: "Nghỉ thai sản",
}

export type AttendanceRequestType = keyof typeof REQUEST_TYPE_LABEL

/** Cấu hình đơn chấm công — default times + monthly quotas. */
export interface AttendanceRequestConfig {
  default_check_in: string
  default_check_out: string
  monthly_forgot_limit: number
  monthly_late_early_limit: number
}

/** Bản ghi đơn chấm công (từ API). */
export interface AttendanceRequest {
  id: number
  user_id: number
  /** Tên người gửi đơn (BE mapRequest trả flat field). */
  user_name: string
  work_date: string
  type: AttendanceRequestType
  /** Giờ đề nghị (khớp BE: requested_check_in / requested_check_out). */
  requested_check_in: string | null
  requested_check_out: string | null
  reason: string
  status: "pending" | "approved" | "rejected"
  reviewed_by: number | null
  /** Tên người duyệt (BE mapRequest trả flat field). */
  reviewer_name: string | null
  reviewed_at: string | null
  review_note: string | null
  created_at: string
  /** Team CHÍNH THỨC của người gửi đơn — null = "Chưa có team". */
  team_name: string | null
}

export interface AttendanceRequestListResult {
  data: AttendanceRequest[]
  pagination: {
    page: number
    page_size: number
    total: number
    total_pages: number
  }
}

/** Lấy cấu hình đơn chấm công (tất cả role xem được). */
export function useRequestConfig() {
  return useQuery<AttendanceRequestConfig>({
    queryKey: [KEY, "request-config"],
    queryFn: () =>
      apiClient.get("/management/attendance/request-config").then((r) => r.data),
    staleTime: 60_000,
  })
}

/** Cập nhật cấu hình đơn chấm công (super_admin + quản lý nhân sự). */
export function useUpdateRequestConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Partial<AttendanceRequestConfig>) =>
      apiClient
        .patch("/management/attendance/request-config", body)
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY, "request-config"] })
    },
  })
}

export interface CreateAttendanceRequestInput {
  work_date: string
  type: AttendanceRequestType
  /** Khớp BE DTO: requested_check_in / requested_check_out (HH:MM). */
  requested_check_in?: string
  requested_check_out?: string
  reason: string
}

/** Tạo đơn chấm công mới. */
export function useCreateRequest() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateAttendanceRequestInput) =>
      apiClient
        .post("/management/attendance/requests", body)
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY, "requests"] })
    },
  })
}

export interface AttendanceRequestsParams {
  status?: "pending" | "approved" | "rejected"
  page?: number
  page_size?: number
  /** lọc theo team_id */
  team_id?: number
  /** lọc theo phòng ban */
  department?: string
  /** lọc theo job_title_id */
  job_title_id?: number
}

/** Danh sách đơn chấm công — admin thấy tất cả, NV thấy đơn của mình. */
export function useAttendanceRequests(params: AttendanceRequestsParams = {}) {
  return useQuery<AttendanceRequestListResult>({
    queryKey: [KEY, "requests", params],
    queryFn: () =>
      apiClient
        .get("/management/attendance/requests", { params })
        .then((r) => r.data),
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  })
}

/** Duyệt đơn chấm công (super_admin + quản lý nhân sự). */
export function useApproveRequest() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, review_note }: { id: number; review_note?: string }) =>
      apiClient
        .post(`/management/attendance/requests/${id}/approve`, { review_note })
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY, "requests"] })
      qc.invalidateQueries({ queryKey: [KEY, "list"] })
      qc.invalidateQueries({ queryKey: [KEY, "today"] })
    },
  })
}

/** Từ chối đơn chấm công (super_admin + quản lý nhân sự). */
export function useRejectRequest() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, review_note }: { id: number; review_note?: string }) =>
      apiClient
        .post(`/management/attendance/requests/${id}/reject`, { review_note })
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [KEY, "requests"] })
      qc.invalidateQueries({ queryKey: [KEY, "list"] })
      qc.invalidateQueries({ queryKey: [KEY, "today"] })
    },
  })
}
