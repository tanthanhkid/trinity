"use client"

import type { ReactNode } from "react"
import type { Permission } from "@trinity/rbac"
import { usePermissions } from "./use-permissions"

export interface CanProps {
  /** Cần ĐÚNG quyền này. */
  perm?: Permission
  /** Cần ÍT NHẤT MỘT trong các quyền này. Bỏ qua nếu `perm` đã truyền. */
  any?: readonly Permission[]
  children: ReactNode
  /** Render khi KHÔNG đủ quyền. Mặc định không render gì. */
  fallback?: ReactNode
}

/**
 * Ẩn/hiện UI theo quyền — thay mọi `role === '...'` / `ROLES.includes(role)`
 * cũ. Không truyền `perm` lẫn `any` → luôn ẩn (fail-closed, tránh quên khai
 * quyền rồi vô tình mở cho mọi người).
 *
 * ```tsx
 * <Can perm="contacts.export"><Button>Xuất Excel</Button></Can>
 * <Can any={["contacts.update", "contacts.delete"]}>...</Can>
 * ```
 */
export function Can({ perm, any, children, fallback = null }: CanProps) {
  const { can, canAny } = usePermissions()
  const ok = perm ? can(perm) : any && any.length > 0 ? canAny(...any) : false
  return <>{ok ? children : fallback}</>
}
