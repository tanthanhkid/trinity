import fs from 'node:fs'
import { request as pwRequest, type APIRequestContext, type APIResponse, type Page } from '@playwright/test'
import type { Grants } from '@trinity/rbac'
import { storageStatePath, type RoleKey } from './roles'
import { bypassHeaders } from './vercel-bypass'

export const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3000'
const API = `${BASE_URL.replace(/\/$/, '')}/api/v1`

interface StoredTokens {
  access: string
  refresh: string
}

/** Đọc token từ `storageState` đã lưu bởi auth.setup (localStorage của origin). */
export function readTokens(role: RoleKey): StoredTokens {
  const raw = JSON.parse(fs.readFileSync(storageStatePath(role), 'utf8')) as {
    origins: { localStorage: { name: string; value: string }[] }[]
  }
  const ls = raw.origins.flatMap((o) => o.localStorage)
  const get = (k: string) => ls.find((i) => i.name === k)?.value ?? ''
  return { access: get('trinity_access_token'), refresh: get('trinity_refresh_token') }
}

export interface MeResponse {
  user: { id: number; email: string; full_name: string }
  roles: { id: number; name: string }[]
  permissions: Grants
  isAdmin: boolean
}

/**
 * Client API dùng token của PHIÊN role (không đụng tới trình duyệt). Access token
 * sống 15 phút → gặp 401 thì tự refresh 1 lần bằng refresh token (stateless, không
 * làm hỏng phiên của trình duyệt).
 */
export class Api {
  private constructor(
    private ctx: APIRequestContext,
    private tokens: StoredTokens,
  ) {}

  static async forRole(role: RoleKey): Promise<Api> {
    const ctx = await pwRequest.newContext({ extraHTTPHeaders: bypassHeaders() })
    return new Api(ctx, readTokens(role))
  }

  async dispose(): Promise<void> {
    await this.ctx.dispose()
  }

  private async refresh(): Promise<void> {
    const res = await this.ctx.post(`${API}/auth/refresh`, { data: { refresh_token: this.tokens.refresh } })
    if (!res.ok()) throw new Error(`refresh token thất bại: HTTP ${res.status()}`)
    const j = (await res.json()) as { access_token: string; refresh_token?: string }
    this.tokens = { access: j.access_token, refresh: j.refresh_token ?? this.tokens.refresh }
  }

  async call(method: string, url: string, data?: unknown, retried = false): Promise<APIResponse> {
    const res = await this.ctx.fetch(`${API}${url}`, {
      method,
      data,
      headers: { Authorization: `Bearer ${this.tokens.access}` },
    })
    if (res.status() === 401 && !retried) {
      await this.refresh()
      return this.call(method, url, data, true)
    }
    return res
  }

  /** GET → JSON (ném lỗi nếu !ok). */
  async get<T = unknown>(url: string): Promise<T> {
    const res = await this.call('GET', url)
    if (!res.ok()) throw new Error(`GET ${url} → HTTP ${res.status()}`)
    return (await res.json()) as T
  }
  async post<T = unknown>(url: string, data?: unknown): Promise<T> {
    const res = await this.call('POST', url, data ?? {})
    if (!res.ok()) throw new Error(`POST ${url} → HTTP ${res.status()}: ${(await res.text()).slice(0, 300)}`)
    return (await res.json().catch(() => ({}))) as T
  }
  async patch<T = unknown>(url: string, data?: unknown): Promise<T> {
    const res = await this.call('PATCH', url, data ?? {})
    if (!res.ok()) throw new Error(`PATCH ${url} → HTTP ${res.status()}: ${(await res.text()).slice(0, 300)}`)
    return (await res.json().catch(() => ({}))) as T
  }
  async put<T = unknown>(url: string, data?: unknown): Promise<T> {
    const res = await this.call('PUT', url, data ?? {})
    if (!res.ok()) throw new Error(`PUT ${url} → HTTP ${res.status()}: ${(await res.text()).slice(0, 300)}`)
    return (await res.json().catch(() => ({}))) as T
  }
  /** DELETE — trả status (dọn dữ liệu không nên làm test đỏ vì 404 đã xoá rồi). */
  async del(url: string): Promise<number> {
    return (await this.call('DELETE', url)).status()
  }

  me(): Promise<MeResponse> {
    return this.get<MeResponse>('/auth/me')
  }
}

/** Token hiện hành trong trình duyệt (app tự refresh → luôn mới hơn file). */
export async function pageToken(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem('trinity_access_token') ?? '')
}
