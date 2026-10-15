"use client"

import { useAuthStore } from "@/store/auth"

/**
 * Nhãn vai trò của user hiện tại — TÊN VAI TRÒ ĐỘNG do admin tạo (`/auth/me`.roles[]),
 * nhiều vai trò nối bằng ", ". Chưa có vai trò / chưa tải xong → chuỗi rỗng (caller tự ẩn dòng nhãn).
 */
export function useRoleNames(): string {
  const roles = useAuthStore((s) => s.roles)
  return (roles ?? []).map((r) => r.name).join(", ")
}
