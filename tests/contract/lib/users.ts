import { seedUser, type Scope } from './db.js'
import { loginSeeded } from './session.js'

export interface U {
  id: number
  token: string
}

/** Người dùng + vai trò riêng với đúng quyền (`true` = quyền không phạm vi), đăng nhập thật, trả id + token. */
export async function makeUser(grants: Record<string, Scope | true> = {}, opts: { managerId?: number } = {}): Promise<U> {
  const mapped: Record<string, Scope> = {}
  for (const [k, v] of Object.entries(grants)) mapped[k] = v === true ? null : v
  const s = await seedUser({ label: 'u', grants: mapped, managerId: opts.managerId })
  return { id: s.id, token: (await loginSeeded(s)).token }
}
