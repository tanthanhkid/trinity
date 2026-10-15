import path from 'node:path'

/** 5 role demo. Thông tin đăng nhập CHỈ đọc từ env `E2E_<ROLE>_EMAIL/PASSWORD`. */
export const ROLES = ['ADMIN', 'SALE', 'LEAD', 'DEPT_HEAD', 'HR'] as const
export type RoleKey = (typeof ROLES)[number]

export const ROLE_LABEL: Record<RoleKey, string> = {
  ADMIN: 'Quản trị',
  SALE: 'Nhân viên kinh doanh',
  LEAD: 'Trưởng nhóm',
  DEPT_HEAD: 'Trưởng phòng',
  HR: 'Nhân sự',
}

export interface Credentials {
  email: string
  password: string
}

export function credentialsFor(role: RoleKey): Credentials | null {
  const email = process.env[`E2E_${role}_EMAIL`]
  const password = process.env[`E2E_${role}_PASSWORD`]
  return email && password ? { email, password } : null
}

export function hasRole(role: RoleKey): boolean {
  return credentialsFor(role) !== null
}

/** Lý do skip chuẩn khi role thiếu env. */
export function missingEnvReason(role: RoleKey): string {
  return `Thiếu env E2E_${role}_EMAIL / E2E_${role}_PASSWORD — bỏ qua role ${role}`
}

export const AUTH_DIR = path.join(__dirname, '..', '.auth')
export function storageStatePath(role: RoleKey): string {
  return path.join(AUTH_DIR, `${role.toLowerCase()}.json`)
}
