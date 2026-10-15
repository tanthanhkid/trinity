import type { Grants } from '@trinity/rbac'

/**
 * 🔴 RBAC quyền + phạm vi — `/auth/me` (và response login/refresh)
 * KHÔNG còn trả `role`/`team_id`/`team_name`; chỉ còn `manager_id`
 * (nguồn phạm vi `own|team|subtree|all`, xem `@trinity/rbac`). Mọi gate phía FE
 * dùng `usePermissions()` (`@/lib/rbac`); tên vai trò hiển thị lấy từ
 * `roles[]` (`useRoleNames()`).
 */
export interface User {
  id: number
  email: string
  full_name: string
  avatar_url: string | null
  manager_id: number | null
  /** `/auth/me` hiện không trả — form Hồ sơ cá nhân (đổi thông tin tài khoản) vẫn gửi `phone` qua PATCH profile. */
  phone?: string | null
}

/** 1 vai trò user đang giữ — trả từ `/auth/me`.roles[] (nhiều vai trò, cộng dồn). */
export interface Role {
  id: number
  name: string
  is_system: boolean
}

export interface AuthTokens {
  accessToken: string
  refreshToken: string
}

/**
 * Hình dạng chung của `/auth/me` VÀ response login/refresh (spec §5.2,
 * `services/auth/src/auth/auth.service.ts` `toMeResponse()`).
 */
export interface AuthMe {
  user: User
  roles: Role[]
  permissions: Grants
  isAdmin: boolean
}
