import { Api } from '../helpers/api'
import { record } from '../helpers/manifest'
import type { RoleKey } from '../helpers/roles'
import { fakePhone, prefix } from '../helpers/data'

/** Hàm tạo bản ghi `E2E-` qua API + ghi manifest NGAY (seed và flows dùng chung). */

export async function userIds(api: Api): Promise<Record<RoleKey, number>> {
  const out = {} as Record<RoleKey, number>
  for (const role of ['ADMIN', 'SALE', 'LEAD', 'DEPT_HEAD', 'HR'] as const) {
    const a = await Api.forRole(role)
    out[role] = (await a.me()).user.id
    await a.dispose()
  }
  return out
}

export async function optionId(api: Api, group: string, value?: string): Promise<number> {
  const r = await api.get<{ data: { id: number; value: string }[] }>(`/settings/options?group=${group}&active=true`)
  const hit = value ? r.data.find((o) => o.value === value) : r.data[0]
  if (!hit) throw new Error(`Không có option ${group}/${value ?? '*'}`)
  return hit.id
}

export async function mkContact(
  api: Api,
  owner: RoleKey,
  tag: string,
  opts: { source_id: number; stage_id?: number },
): Promise<{ id: number; name: string; phone: string }> {
  const name = prefix(tag)
  const phone = fakePhone()
  const r = await api.post<{ contact: { id: number } }>('/contacts', { phone, full_name: name, ...opts })
  record({
    kind: 'contact', id: r.contact.id, label: name, meta: { owner, phone }, del: `/contacts/${r.contact.id}`,
    soft: { table: 'contacts', note: 'xoá mềm (deleted_at); kèm activities/contact_events liên quan' },
  })
  return { id: r.contact.id, name, phone }
}

/**
 * Mật khẩu của user thử SUY RA từ email (không lưu ở đâu cả) — user bị khoá/xoá cuối lần chạy.
 * Đặt `E2E_THROWAWAY_SUFFIX` để đổi hậu tố khi chạy trên môi trường dùng chung.
 */
export function throwawayPassword(email: string): string {
  return `E2e!${email.replace(/\D/g, '')}${process.env.E2E_THROWAWAY_SUFFIX || 'Zz'}`
}

export async function mkUser(api: Api, tag: string): Promise<{ id: number; email: string; password: string; name: string }> {
  const email = `e2e-${Date.now()}-${tag}@trinity.local`
  const password = throwawayPassword(email)
  const name = prefix(tag)
  const u = await api.post<{ id: number }>('/users', { email, full_name: name, password })
  record({
    kind: 'user', id: u.id, label: email, del: `/users/${u.id}/permanent`,
    soft: { table: 'users', note: 'xoá mềm (deleted_at, status=locked); email đã đổi/khoá' },
  })
  // POST /users tự tạo kèm 1 hồ sơ nhân viên (hiện trong Quản lý nhân viên) → ghi để cleanup xoá luôn.
  const emps = await api.get<{ data: { id: number; user_id: number }[] }>('/management/employees?page_size=100')
  const emp = emps.data.find((e) => e.user_id === u.id)
  if (!emp) throw new Error(`Không thấy hồ sơ nhân viên của user ${u.id} (${email}) — sẽ không dọn được`)
  if (emp) {
    record({
      kind: 'employee', id: emp.id, label: `hồ sơ NV của ${email}`, del: `/management/employees/${emp.id}`,
      soft: { table: 'employees', note: 'hồ sơ nhân viên tự tạo kèm user E2E- (xoá mềm)' },
    })
  }
  return { id: u.id, email, password, name }
}

export async function mkRole(api: Api, tag: string, grants: Record<string, unknown>): Promise<{ id: number; name: string }> {
  const name = prefix(tag)
  const r = await api.post<{ id: number }>('/roles', { name, description: 'E2E — vai trò thử, xoá sau test', grants })
  record({ kind: 'role', id: r.id, label: name, del: `/roles/${r.id}` })
  return { id: r.id, name }
}

/** Gán vai trò + ghi `pre` để cleanup gỡ gán trước khi xoá vai trò. */
export function recordRoleUnassign(userId: number): void {
  record({
    kind: 'role-assignment', id: userId, label: `gỡ vai trò khỏi user ${userId}`,
    pre: [{ method: 'PUT', url: `/users/${userId}/roles`, data: { roleIds: [] } }],
  })
}
