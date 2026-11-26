import { expect } from 'vitest'
import { config } from './config.js'
import { q, seedUser, type Scope } from './db.js'
import { api, freshIp, type Res } from './http.js'
import { loginSeeded } from './session.js'

/** Dùng chung cho ca thực thể tuỳ biến và mẫu (C09). */
export const BASE = '/custom-objects'

/** e2e gốc dọn bảng ở `afterEach`; hộp đen dùng một DB cho cả hồ sơ nên mỗi ca tự dọn ở đầu. */
export async function resetCustom(): Promise<void> {
  await q(`TRUNCATE TABLE custom_records, custom_fields, custom_objects, integration_events RESTART IDENTITY CASCADE`)
}

export const count = async (table: 'custom_objects' | 'custom_fields' | 'custom_records'): Promise<number> =>
  (await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0].n

type Grants = Record<string, Scope | true>
export interface U {
  id: number
  token: string
}

/** Người dùng riêng với quyền cho trước (`true` = không giới hạn phạm vi, như `makeUser` của e2e gốc). */
/** Tên hiển thị của người dùng nằm trong response nên nhãn phải ổn định giữa các lần chạy: đánh số tuần tự. */
let userSeq = 0
export async function mk(grants: Grants, extra: { managerId?: number } = {}): Promise<U> {
  const g: Record<string, Scope> = {}
  for (const [k, v] of Object.entries(grants)) g[k] = v === true ? null : v
  const u = await seedUser({ label: `u${++userSeq}`, grants: g, managerId: extra.managerId })
  return { id: u.id, token: (await loginSeeded(u)).token }
}

export const roleOf = async (userId: number): Promise<number> => (await q<{ role_id: number }>(`SELECT role_id FROM user_roles WHERE user_id = $1 LIMIT 1`, [userId]))[0].role_id

/** Lời gọi có token; `query` thành chuỗi truy vấn. */
export function a(token?: string) {
  const url = (p: string, query?: Record<string, string>): string => (query ? `${p}?${new URLSearchParams(query).toString()}` : p)
  return {
    get: (p: string, query?: Record<string, string>) => api.get(url(p, query), { token, ip: freshIp() }),
    post: (p: string, body: unknown = {}) => api.post(p, { token, body, ip: freshIp() }),
    patch: (p: string, body: unknown = {}) => api.patch(p, { token, body, ip: freshIp() }),
    del: (p: string) => api.del(p, { token, ip: freshIp() }),
  }
}

/** `.expect(status)` của supertest: chờ response, khẳng định mã (in cả body khi sai) rồi trả response. */
export async function st(res: Promise<Res>, status: number): Promise<Res> {
  const r = await res
  expect({ status: r.status, body: r.body }).toMatchObject({ status })
  return r
}

/** POST thân JSON thô (cần khoá `__proto__`/`constructor`, `JSON.stringify` của client không tạo được). */
export async function postRaw(path: string, token: string, raw: string): Promise<Res> {
  const res = await fetch(`${config.baseUrl}/api/v1${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-real-ip': freshIp() },
    body: raw,
  })
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    /* giữ chuỗi */
  }
  return { status: res.status, headers: res.headers, body }
}

export const ALL = { 'custom_objects.manage': true, 'custom_records.view': 'all', 'custom_records.manage': 'all', 'custom_records.delete': 'all', 'custom_records.export': 'all', 'custom_records.phone_full': 'all' } as const satisfies Grants
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Body = any

/** GET lấy byte thô: `Response.text()` của fetch tự bỏ BOM UTF-8, nên ca kiểm BOM phải đọc byte. */
export async function getBytes(path: string, token: string): Promise<Uint8Array> {
  const res = await fetch(`${config.baseUrl}/api/v1${path}`, { headers: { authorization: `Bearer ${token}`, 'x-real-ip': freshIp() } })
  return new Uint8Array(await res.arrayBuffer())
}
