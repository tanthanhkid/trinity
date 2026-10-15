import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"

/** Danh sách phòng ban mặc định — fallback khi đang tải / lỗi (khớp seed BE). */
export const DEFAULT_DEPARTMENTS = [
  "Kinh doanh",
  "Kế toán",
  "Hành chính",
  "Marketing",
  "Vận hành",
  "Công nghệ",
  "Khác",
]

const DEPARTMENTS_KEY = ["settings", "departments"] as const

/**
 * Danh sách phòng ban cấu hình chung (cấu hình tại Cài đặt → Phòng ban).
 * Mọi dropdown (NV / hợp đồng / tuyển dụng / lọc thống kê) đọc từ đây để nhất quán.
 * Trả mảng phòng ban; fallback DEFAULT_DEPARTMENTS khi đang tải hoặc lỗi.
 */
export function useDepartments(): string[] {
  const { data } = useQuery<{ departments: string[] }>({
    queryKey: DEPARTMENTS_KEY,
    queryFn: async () =>
      (await apiClient.get<{ departments: string[] }>("/settings/departments")).data,
    staleTime: 5 * 60_000,
  })
  return data?.departments ?? DEFAULT_DEPARTMENTS
}

/** Mutation cập nhật danh sách phòng ban (super_admin + quản lý nhân sự). */
export function useUpdateDepartments() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (departments: string[]) =>
      (
        await apiClient.patch<{ departments: string[] }>("/settings/departments", {
          departments,
        })
      ).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: DEPARTMENTS_KEY })
    },
  })
}
