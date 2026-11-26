import { api, freshIp } from './http.js'
import { config } from './config.js'
import type { SeededUser } from './db.js'

export interface Session {
  token: string
  user: { id?: number; email: string }
}

export async function login(email: string, password: string): Promise<Session> {
  const res = await api.post('/auth/login', { body: { email, password }, ip: freshIp() })
  if (res.status !== 200) throw new Error(`login ${email} -> ${res.status} ${JSON.stringify(res.body)}`)
  const b = res.body as { access_token?: string; accessToken?: string; user?: { id?: number; email: string } }
  const token = b.access_token ?? b.accessToken
  if (!token) throw new Error(`login không trả access token: ${JSON.stringify(res.body).slice(0, 200)}`)
  return { token, user: b.user ?? { email } }
}

export const loginAdmin = (): Promise<Session> => login(config.adminEmail, config.adminPassword)
export const loginSeeded = (u: SeededUser): Promise<Session> => login(u.email, u.password)

/** Công ty thứ hai qua API đăng ký thật (MULTI_TENANT): trả token của chủ công ty mới. */
export async function registerCompany(name: string): Promise<{ session: Session; email: string; password: string }> {
  const email = `owner-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}@contract.test`
  const password = 'Contract-Pass-123'
  const res = await api.post('/auth/register', {
    body: { company_name: name, full_name: 'Chủ công ty hai', email, password },
    ip: freshIp(),
  })
  if (res.status !== 201) throw new Error(`register -> ${res.status} ${JSON.stringify(res.body)}`)
  const b = res.body as { access_token?: string; accessToken?: string; user?: { id?: number; email: string } }
  return { session: { token: (b.access_token ?? b.accessToken) as string, user: b.user ?? { email } }, email, password }
}
