import type { Grants } from '@trinity/rbac'

export interface AuthUser {
  userId: number
  email: string
  isAdmin: boolean
  grants: Grants
}
