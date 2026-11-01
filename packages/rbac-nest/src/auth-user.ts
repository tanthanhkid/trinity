import type { Grants } from '@trinity/rbac'

export interface AuthUser {
  userId: number
  email: string
  /** Company the user belongs to (multi-tenant; 1 in single-tenant installs). */
  companyId?: number
  isAdmin: boolean
  grants: Grants
}
