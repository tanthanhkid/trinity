"use client"

import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import { usePermissions } from "@/lib/rbac"

export const EMPLOYEES_PAGE_SIZE = 10

export interface EmployeeFilters {
  search?: string
  department?: string
  position?: string
  status?: string
  team?: string
  // Tình trạng tài khoản: active=đang làm, resigned=đã nghỉ (vô hiệu hoá), all=tất cả
  employment_state?: "active" | "resigned" | "all"
  page?: number
  sort_by?: string
  sort_dir?: "asc" | "desc"
}

export interface EmployeeUser {
  id: number
  email: string
  full_name: string | null
  phone: string | null
  avatar_url: string | null
  role: string
  status: string
}

export interface Employee {
  id: number
  user_id: number
  employee_code: string
  full_name: string | null
  email: string
  phone: string | null
  avatar_url: string | null
  position: string | null
  department: string | null
  gender: string | null
  education_level: string | null
  recruitment_source: string | null
  status: string | null
  user_status: string
  role: string | null
  team_id: number | null
  manager_id: number | null
  // Tên Bộ phận (trưởng nhóm/trưởng phòng phụ trách) — null khi chưa gán
  manager_name: string | null
  // Team (trưởng nhóm trực thuộc, self-aware) + id để tô màu / sort
  team_name: string | null
  team_lead_id: number | null
  salary_rule_id: number | null
  // Mức lương đóng BHXH (nhập tay) — null = dùng lương cơ bản
  insurance_salary: number | null
  job_title_id: number | null
  job_title_name: string | null
  job_title_category: string | null
  job_title_rank_code: string | null
  job_title_symbol: string | null
  joined_at: string | null
  // Hồ sơ nhân sự cá nhân
  birth_date: string | null
  id_card_number: string | null
  id_card_issued_date: string | null
  id_card_issued_place: string | null
  permanent_address: string | null
  current_address: string | null
  bank_account_number: string | null
  bank_name: string | null
  bank_account_holder: string | null
  // Chấm công theo IP văn phòng + token thiết bị
  office_id: number | null
  office_name: string | null
  registered_device_id: string | null
  device_registered_at: string | null
  created_at: string
  // Legacy nested user object kept for backward compat
  user?: EmployeeUser
}

export interface EmployeesResponse {
  data: Employee[]
  pagination: {
    total: number
    page: number
    page_size: number
    total_pages: number
  }
}

/**
 * Trạng thái HIỂN THỊ cho cột "Trạng thái": tài khoản bị khóa = đã nghỉ việc
 * (nguồn sự thật) → luôn hiện "resigned" bất kể `employee.status`, để cột
 * không mâu thuẫn với tài khoản đã bị vô hiệu hoá. Tài khoản còn hoạt động →
 * giữ nguyên `employee.status` (chỉ suy diễn "nghỉ việc" khi CHẮC CHẮN locked).
 */
export function resolveEmployeeDisplayStatus(
  employeeStatus: string | null,
  userStatus: string | null | undefined,
): string | null {
  if (userStatus === "locked") return "resigned"
  return employeeStatus
}

export interface CreateEmployeeDto {
  email: string
  full_name: string
  password?: string
  employee_code?: string
  position?: string
  phone?: string
  role?: string
  department?: string
  gender?: string
  education_level?: string
  recruitment_source?: string
  status?: string
  joined_at?: string
  birth_date?: string
  id_card_number?: string
  id_card_issued_date?: string
  id_card_issued_place?: string
  permanent_address?: string
  current_address?: string
  bank_account_number?: string
  bank_name?: string
  bank_account_holder?: string
  team_id?: number
  manager_id?: number
  salary_rule_id?: number
  insurance_salary?: number | null
  job_title_id?: number
  avatar_url?: string | null
  office_id?: number | null
}

export interface UpdateEmployeeDto {
  full_name?: string
  phone?: string | null
  employee_code?: string
  position?: string
  role?: string
  department?: string
  gender?: string
  education_level?: string
  recruitment_source?: string
  status?: string
  joined_at?: string
  birth_date?: string | null
  id_card_number?: string | null
  id_card_issued_date?: string | null
  id_card_issued_place?: string | null
  permanent_address?: string | null
  current_address?: string | null
  bank_account_number?: string | null
  bank_name?: string | null
  bank_account_holder?: string | null
  team_id?: number
  // null = bỏ gán Bộ phận; số = gán trưởng nhóm/trưởng phòng
  manager_id?: number | null
  salary_rule_id?: number
  insurance_salary?: number | null
  job_title_id?: number
  avatar_url?: string | null
  office_id?: number | null
}

export function useEmployees(filters: EmployeeFilters) {
  const params = new URLSearchParams()
  if (filters.search) params.set("search", filters.search)
  if (filters.department) params.set("department", filters.department)
  if (filters.position) params.set("position", filters.position)
  if (filters.status) params.set("status", filters.status)
  if (filters.team) params.set("team", filters.team)
  if (filters.employment_state) params.set("employment_state", filters.employment_state)
  if (filters.sort_by) params.set("sort_by", filters.sort_by)
  if (filters.sort_dir) params.set("sort_dir", filters.sort_dir)
  params.set("page", String(filters.page ?? 1))
  params.set("page_size", String(EMPLOYEES_PAGE_SIZE))
  const canViewEmployees = usePermissions().can("employees.view")

  return useQuery<EmployeesResponse>({
    queryKey: ["employees", filters],
    enabled: canViewEmployees,
    queryFn: async () => {
      const res = await apiClient.get<EmployeesResponse>(`/management/employees?${params.toString()}`)
      return res.data
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
}

/**
 * Tải TẤT CẢ nhân viên (gộp nhiều trang vì BE giới hạn page_size ≤ 100) — phục vụ
 * lọc/sort/phân trang client-side trên toàn bộ dữ liệu (vd tab Lương → Nhân viên
 * sort theo KPI%/Lương/Target — các cột tính sẵn không sort được phía server).
 */
export function useAllEmployees() {
  // BE `GET /management/employees` gate `employees.view` — thiếu quyền → không gọi (403).
  const canViewEmployees = usePermissions().can("employees.view")
  return useQuery<Employee[]>({
    queryKey: ["employees", "all"],
    enabled: canViewEmployees,
    queryFn: async () => {
      const PAGE = 100
      const first = await apiClient.get<EmployeesResponse>(
        `/management/employees?page=1&page_size=${PAGE}`,
      )
      const totalPages = Math.max(1, Math.ceil(first.data.pagination.total / PAGE))
      if (totalPages <= 1) return first.data.data
      const rest = await Promise.all(
        Array.from({ length: totalPages - 1 }, (_, i) =>
          apiClient
            .get<EmployeesResponse>(`/management/employees?page=${i + 2}&page_size=${PAGE}`)
            .then((r) => r.data.data),
        ),
      )
      return [first.data.data, ...rest].flat()
    },
    staleTime: 30_000,
  })
}

export function useEmployee(id: number | null) {
  return useQuery<Employee>({
    queryKey: ["employees", id],
    queryFn: async () => {
      const res = await apiClient.get<Employee>(`/management/employees/${id}`)
      return res.data
    },
    enabled: id !== null,
    staleTime: 30_000,
  })
}

export function useCreateEmployee() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (dto: CreateEmployeeDto) => {
      const res = await apiClient.post<Employee>("/management/employees", dto)
      return res.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employees"] })
      // NV mới cũng là 1 user — Settings > Người dùng (queryKey ["users","org-tree"])
      // phải phản ánh NGAY cùng phiên, không đợi remount/staleTime hết hạn.
      qc.invalidateQueries({ queryKey: ["users"] })
    },
  })
}

export function useUpdateEmployee(id: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (dto: UpdateEmployeeDto) => {
      const res = await apiClient.patch<Employee>(`/management/employees/${id}`, dto)
      return res.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employees"] })
      // sửa NV có thể đổi role/team → đồng bộ Settings > Người dùng cùng phiên.
      qc.invalidateQueries({ queryKey: ["users"] })
    },
  })
}

export function useLockEmployee(id: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const res = await apiClient.patch<{ ok: boolean }>(`/management/employees/${id}/lock`, {})
      return res.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employees"] })
    },
  })
}

export function useDeleteEmployee(id: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const res = await apiClient.delete<{ ok: boolean }>(`/management/employees/${id}`)
      return res.data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employees"] })
    },
  })
}

// --- Thống kê nhân viên ---

export interface EmployeeStatRow {
  label: string
  count: number
}

export interface EmployeeStats {
  by_department: EmployeeStatRow[]
  by_gender: EmployeeStatRow[]
  by_education: EmployeeStatRow[]
  by_job_title: EmployeeStatRow[]
  by_status: EmployeeStatRow[]
  // Số NV đã nghỉ việc (tài khoản vô hiệu hoá, users.status='locked') — metric riêng
  resigned_total: number
}

export function useEmployeeStats(enabled = false) {
  return useQuery<EmployeeStats>({
    queryKey: ["employees", "stats"],
    queryFn: async () => {
      const res = await apiClient.get<EmployeeStats>("/management/employees/stats")
      return res.data
    },
    enabled,
    staleTime: 60_000,
  })
}

// --- Dashboard "Thống kê nhân viên": Team + Sinh nhật ---

export interface HrStatsFilters {
  office_id?: number
  department?: string
  // team_lead user id (số) hoặc "none" (Chưa có team)
  team?: string
  job_title_id?: number
}

export interface TeamStructureRow {
  team_lead_id: number | null
  team_name: string
  count: number
  percent: number
}

export interface TeamStatusRow {
  team_lead_id: number | null
  team_name: string
  active: number
  probation: number
  on_leave: number
  resigned: number
  other: number
}

export interface BirthdayMonthRow {
  month: number
  count: number
  percent: number
}

/** Dòng {team_lead_id, team_name, count} cho thống kê NV đã nghỉ theo team. */
export interface ResignedTeamRow {
  team_lead_id: number | null
  team_name: string
  count: number
}

/** Dòng {label, count} cho thống kê NV đã nghỉ theo phòng ban / chức vụ. */
export interface LabelCountRow {
  label: string
  count: number
}

export interface HrStats {
  total: number
  by_team: TeamStructureRow[]
  by_team_status: TeamStatusRow[]
  birthdays_by_month: BirthdayMonthRow[]
  // Thống kê NV đã nghỉ việc (tài khoản vô hiệu hoá) — chia theo team cũ/phòng/chức vụ
  resigned_total: number
  resigned_by_team: ResignedTeamRow[]
  resigned_by_department: LabelCountRow[]
  resigned_by_job_title: LabelCountRow[]
}

export interface BirthdayItem {
  id: number
  employee_code: string
  full_name: string | null
  birth_date: string | null
  day: number
  position: string | null
  job_title_name: string | null
  team_name: string
  department: string | null
  email: string
  phone: string | null
}

export interface BirthdayList {
  month: number
  items: BirthdayItem[]
}

function hrStatsParams(f: HrStatsFilters): URLSearchParams {
  const p = new URLSearchParams()
  if (f.office_id != null) p.set("office_id", String(f.office_id))
  if (f.department) p.set("department", f.department)
  if (f.team) p.set("team", f.team)
  if (f.job_title_id != null) p.set("job_title_id", String(f.job_title_id))
  return p
}

export function useHrStats(filters: HrStatsFilters) {
  const params = hrStatsParams(filters)
  const { can } = usePermissions()
  return useQuery<HrStats>({
    enabled: can("employees.view"),
    queryKey: ["employees", "hr-stats", filters],
    queryFn: async () => {
      const res = await apiClient.get<HrStats>(
        `/management/employees/hr-stats?${params.toString()}`,
      )
      return res.data
    },
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  })
}

export function useBirthdayList(filters: HrStatsFilters & { month: number }) {
  const params = hrStatsParams(filters)
  params.set("month", String(filters.month))
  const { can } = usePermissions()
  return useQuery<BirthdayList>({
    enabled: can("employees.view"),
    queryKey: ["employees", "birthdays", filters],
    queryFn: async () => {
      const res = await apiClient.get<BirthdayList>(
        `/management/employees/birthdays?${params.toString()}`,
      )
      return res.data
    },
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  })
}

/** Tải Excel danh sách sinh nhật (super_admin + quản lý nhân sự). Trả Blob để component tự download. */
export function useBirthdayExport() {
  return useMutation({
    mutationFn: async (filters: HrStatsFilters & { month: number }) => {
      const params = hrStatsParams(filters)
      params.set("month", String(filters.month))
      const res = await apiClient.get<Blob>(
        `/management/employees/birthdays/export?${params.toString()}`,
        { responseType: "blob" },
      )
      return res.data
    },
  })
}
