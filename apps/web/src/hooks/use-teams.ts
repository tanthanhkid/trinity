import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"

export interface Team {
  id: number
  name: string
  department: string | null
  description: string | null
  team_lead_id: number | null
  team_lead_name: string | null
  member_count: number
}

export interface CreateTeamDto {
  name: string
  department?: string | null
  description?: string | null
  team_lead_id?: number | null
}

export type UpdateTeamDto = Partial<CreateTeamDto>

const TEAMS_KEY = ["management", "teams"] as const
const TEAMS_FOR_FILTER_KEY = ["management", "teams", "for-filter"] as const
const TEAM_LEADS_FOR_FILTER_KEY = ["management", "teams", "lead-filter"] as const

/** Danh sách Team (kèm phòng ban + trưởng nhóm + số thành viên). super_admin/quản lý nhân sự. */
export function useTeams() {
  return useQuery<Team[]>({
    queryKey: TEAMS_KEY,
    queryFn: async () => (await apiClient.get<Team[]>("/management/teams")).data,
    staleTime: 30_000,
  })
}

export interface TeamForFilter {
  id: number
  name: string
  /**
   * User id của trưởng nhóm — CHỈ để hiển thị/tô màu (vd `teamColorClass`). KHÔNG
   * dùng làm giá trị filter `team` gửi lên BE — dùng `id` (xem bên dưới).
   * Có thể null khi team chưa gán Người phụ trách (vd "Nhân viên A").
   */
  team_lead_id: number | null
  /** Phòng ban của team — dùng để cascade Phòng ban→Team ở FE. */
  department: string | null
}

/**
 * Danh sách Team Active dùng làm dropdown bộ lọc.
 * Mặc định (`includeUnled` không truyền/false) — Active = team có trưởng nhóm,
 * hành vi GIỮ NGUYÊN cho các dropdown cũ (payroll/contract-stats-dialog) vốn
 * dùng `team_lead_id` làm giá trị filter.
 *
 * `includeUnled: true` (chỉ dùng ở /management/employees + /management/contracts):
 * MỞ RỘNG thêm team chưa gán Người phụ trách nhưng có nhân viên gán trực tiếp (vd
 * "Nhân viên A" — Phòng Ví dụ). **Giá trị filter `team` gửi lên BE PHẢI là `String(t.id)`**
 * (id CHÍNH THỨC bảng `teams`) — KHÔNG phải `team_lead_id` (một số team không có,
 * và employees.service/contracts.service đã đổi sang so khớp theo `id`).
 * Dynamic: load lại khi staleTime 60s hết hạn — đồng bộ với Cài đặt > Team.
 */
export function useTeamsForFilter(options?: { includeUnled?: boolean }) {
  const includeUnled = options?.includeUnled ?? false
  return useQuery<TeamForFilter[]>({
    queryKey: [...TEAMS_FOR_FILTER_KEY, includeUnled],
    queryFn: async () =>
      (
        await apiClient.get<TeamForFilter[]>(
          `/management/teams/for-filter${includeUnled ? "?include_unled=true" : ""}`,
        )
      ).data,
    staleTime: 60_000,
  })
}

/** 1 lựa chọn dropdown "Team" theo trưởng nhóm — khớp
 * `TeamLeadFilterRow` của `services/crm/src/teams/teams.service.ts`. */
export interface TeamLeadForFilter {
  /** CRM user id của trưởng nhóm — ĐÂY là giá trị filter gửi lên BE
   * (`teamLeadId`), KHÔNG phải `teams.id`. */
  team_lead_id: number
  /** Nhãn hiển thị: tên team admin đã đặt (nếu có dòng `teams`), nếu không thì họ tên trưởng nhóm. */
  name: string
}

/**
 * Dropdown "Team" theo trưởng nhóm (vd thống kê nhân sự).
 *
 * ⚠️ KHÔNG dùng `useTeamsForFilter()` ở các màn đó: bảng `teams` (Cài đặt > Team)
 * là nguồn KHÁC với thứ bộ lọc thật sự lọc (cây `users.manager_id`, resolve
 * từ `teamLeadId`). Trưởng nhóm có role `team_lead` + có cấp dưới nhưng chưa
 * được tạo dòng `teams` sẽ biến mất khỏi bộ lọc.
 * Endpoint này trả HỢP 2 nguồn nên là SIÊU TẬP của danh sách cũ.
 *
 * Các màn khác (Lương/Nhân viên/HĐ/Chấm công) GIỮ `useTeamsForFilter()` —
 * chúng lọc theo đúng thực thể `teams`.
 */
export function useTeamLeadsForFilter(options?: { enabled?: boolean }) {
  return useQuery<TeamLeadForFilter[]>({
    queryKey: TEAM_LEADS_FOR_FILTER_KEY,
    queryFn: async () =>
      (await apiClient.get<TeamLeadForFilter[]>("/management/teams/lead-filter")).data,
    staleTime: 60_000,
    // Caller nào chỉ render bộ lọc cho 1 nhóm role thì truyền `enabled`
    // để KHÔNG gọi API cho role không thấy bộ lọc.
    enabled: options?.enabled ?? true,
  })
}

export function useCreateTeam() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (dto: CreateTeamDto) =>
      (await apiClient.post<Team>("/management/teams", dto)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TEAMS_KEY })
    },
  })
}

export function useUpdateTeam() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, dto }: { id: number; dto: UpdateTeamDto }) =>
      (await apiClient.patch<Team>(`/management/teams/${id}`, dto)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TEAMS_KEY })
    },
  })
}

export function useDeleteTeam() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) =>
      (await apiClient.delete(`/management/teams/${id}`)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TEAMS_KEY })
    },
  })
}

export interface TeamMember {
  user_id: number
  full_name: string | null
  email: string | null
  role: string | null
}

/** Nhân viên đã gán TRỰC TIẾP vào team (employees.team_id). */
export function useTeamMembers(teamId: number | null) {
  return useQuery<TeamMember[]>({
    queryKey: [...TEAMS_KEY, "members", teamId],
    queryFn: async () =>
      (await apiClient.get<TeamMember[]>(`/management/teams/${teamId}/members`))
        .data,
    enabled: teamId != null,
    staleTime: 10_000,
  })
}

export function useAddTeamMembers() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ teamId, userIds }: { teamId: number; userIds: number[] }) =>
      (
        await apiClient.post(`/management/teams/${teamId}/members`, {
          user_ids: userIds,
        })
      ).data,
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: TEAMS_KEY })
      void qc.invalidateQueries({ queryKey: [...TEAMS_KEY, "members", vars.teamId] })
    },
  })
}

export function useRemoveTeamMember() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ teamId, userId }: { teamId: number; userId: number }) =>
      (await apiClient.delete(`/management/teams/${teamId}/members/${userId}`)).data,
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: TEAMS_KEY })
      void qc.invalidateQueries({ queryKey: [...TEAMS_KEY, "members", vars.teamId] })
    },
  })
}
