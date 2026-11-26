import { createCipheriv, randomBytes } from 'node:crypto'
import type { Call, Rule } from '../mock/channels.js'
import { graphError } from '../mock/channels.js'
import { config } from './config.js'
import { q } from './db.js'

export { graphError }
export type { Call, Rule }

async function ctl<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${config.mockUrl}/__mock/${path}`, {
    method: body === undefined && path === 'calls' ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return (await res.json()) as T
}

/** Máy chủ giả Graph/Zalo của bộ chạy: đặt lại, thêm kịch bản lỗi, đọc lời gọi đã ghi. */
export const mock = {
  reset: (): Promise<unknown> => ctl('reset', {}),
  rules: (...rules: Rule[]): Promise<unknown> => ctl('rules', rules),
  calls: async (): Promise<Call[]> => (await ctl<{ calls: Call[] }>('calls')).calls,
  unexpected: async (): Promise<Call[]> => (await ctl<{ unexpected: Call[] }>('calls')).unexpected,
}

/** Lỗi Graph theo mã (HTTP đi kèm như Meta trả). */
export const graphFail = (match: string, code: number, subcode?: number, status = 400, times?: number): Rule => ({
  match,
  status,
  json: graphError(code, subcode),
  times,
})

/** `v1.<iv>.<tag>.<ct>` (AES-256-GCM, AAD `trinity-webhook-secret/v1`) — cùng định dạng `secret-crypto.ts`; seed bản mã bằng SQL. */
export function encryptSecret(plain: string): string {
  if (!config.secretKey) throw new Error('Hồ sơ này không có INTEGRATIONS_SECRET_KEY để seed bản mã')
  const key = Buffer.from(config.secretKey, 'base64')
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from('trinity-webhook-secret/v1'))
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.')
}

export async function seedFacebookPage(opts: { pageId: string; adminId: number; token?: string }): Promise<number> {
  const [src] = await q<{ id: number }>(`SELECT id FROM setting_options WHERE group_key = 'contact_source' ORDER BY id LIMIT 1`)
  const [row] = await q<{ id: number }>(
    `INSERT INTO facebook_pages (page_id, name, token_enc, token_status, default_assignee_id, contact_source_id, connected_by, updated_at)
     VALUES ($1, $2, $3, 'unknown', $4, $5, $4, now()) RETURNING id`,
    [opts.pageId, `Page ${opts.pageId}`, encryptSecret(opts.token ?? 'page-token-mock'), opts.adminId, src.id],
  )
  return row.id
}

export async function seedFacebookConversation(opts: { pageId: string; psid: string; inboundMinutesAgo: number }): Promise<number> {
  const [row] = await q<{ id: number }>(
    `INSERT INTO facebook_conversations (page_id, psid, customer_name, last_inbound_at, last_message_at)
     VALUES ($1, $2, 'Khách seed', now() - ($3 || ' minutes')::interval, now() - ($3 || ' minutes')::interval) RETURNING id`,
    [opts.pageId, opts.psid, String(opts.inboundMinutesAgo)],
  )
  return row.id
}

export async function seedZaloConnection(opts: { oaId: string; adminId: number; accessExpiresInMinutes: number }): Promise<void> {
  await q(
    `INSERT INTO zalo_oa_connections (oa_id, access_token_enc, refresh_token_enc, access_expires_at, refresh_expires_at, status, connected_by, updated_at)
     VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval, now() + interval '30 days', 'active', $5, now())`,
    [opts.oaId, encryptSecret('zalo-access-seed'), encryptSecret('zalo-refresh-seed'), String(opts.accessExpiresInMinutes), opts.adminId],
  )
}

export async function seedZaloThread(opts: { oaId: string; zaloUserId: string; inboundMinutesAgo: number }): Promise<number> {
  const [row] = await q<{ id: number }>(
    `INSERT INTO zalo_oa_threads (oa_id, zalo_user_id, display_name, last_inbound_at, last_message_at, updated_at)
     VALUES ($1, $2, 'Khách Zalo seed', now() - ($3 || ' minutes')::interval, now() - ($3 || ' minutes')::interval, now()) RETURNING id`,
    [opts.oaId, opts.zaloUserId, String(opts.inboundMinutesAgo)],
  )
  return row.id
}
