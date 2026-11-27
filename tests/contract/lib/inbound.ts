import { createHash, createHmac } from 'node:crypto'
import { config } from './config.js'
import { q, seedContact } from './db.js'
import { call, freshIp, type Res } from './http.js'
import { a, mk, st, type U } from './webhooks.js'

/**
 * Dùng chung cho ca webhook VÀO (C12b): nguồn nhận khách, chữ ký, dọn dữ liệu bằng SQL. Không import mã backend.
 * Bảng ánh xạ env của e2e gốc → hồ sơ nằm ở `tests/contract/README.md` (mục "Webhook vào và tích hợp").
 */
export const S = '/integrations/webhooks/inbound-sources'
export const HOOK = '/api/v1/hooks/in'
export const PHONES = ['0900001501', '0900001602', '0900001703', '0900001804', '0900001905']
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

/** `X-Trinity-Signature: t=<giây>,v1=<hex HMAC-SHA256(secret, "<t>.<thân>")>` (viết lại độc lập với mã backend). */
export function signHeader(secret: string, raw: string | Buffer, atMs = Date.now()): string {
  const t = Math.floor(atMs / 1000)
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex')}`
}

/** Dọn mọi thứ ca webhook vào đụng tới (e2e gốc dọn ở `afterEach`; hộp đen dùng một DB nên dọn ở đầu mỗi ca). */
export async function resetInbound(): Promise<void> {
  await q(`TRUNCATE TABLE webhook_deliveries, webhook_endpoints, webhook_inbound_sources, webhook_inbound_receipts, integration_events, integration_audit_logs RESTART IDENTITY`)
  await q(`DELETE FROM activities WHERE contact_id IN (SELECT id FROM contacts WHERE phone = ANY($1))`, [PHONES])
  await q(`DELETE FROM contacts WHERE phone = ANY($1)`, [PHONES])
  await q(`UPDATE setting_options SET is_active = true WHERE group_key = 'contact_source' AND value LIKE 'e2e_in_%'`)
}

export interface InboundFixtures {
  srcOpt: number
  srcOpt2: number
  projectId: number
}

/** Hai nguồn khách + một dự án cho ca nhận khách (e2e gốc `upsert` bằng Prisma). */
export async function seedInboundFixtures(): Promise<InboundFixtures> {
  const opt = async (value: string): Promise<number> =>
    (
      await q<{ id: number }>(
        `INSERT INTO setting_options (group_key, value, label, updated_at) VALUES ('contact_source', $1, $1, now())
         ON CONFLICT (group_key, value) DO UPDATE SET is_active = true RETURNING id`,
        [value],
      )
    )[0].id
  const projectId = (
    await q<{ id: number }>(`INSERT INTO projects (name, code, updated_at) VALUES ('E2E in', 'E2E_IN', now()) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`)
  )[0].id
  return { srcOpt: await opt('e2e_in_src'), srcOpt2: await opt('e2e_in_src2'), projectId }
}

export interface Source {
  id: number
  token: string
  path: string
  signing_secret?: string
}

/** Người nhận (`sale`) + người cấu hình (`boss`) + một nguồn tạo qua API. */
export async function setupSource(fx: InboundFixtures, over: { signed?: boolean } = {}): Promise<{ sale: U; boss: U; src: Source }> {
  const sale = await mk({ 'contacts.view': 'own' })
  const boss = await mk({ 'integrations.webhooks': true, 'contacts.create': true, 'contacts.transfer': 'all' })
  const res = await st(a(boss.token).post(S, { name: 'FB form', default_assignee_id: sale.id, contact_source_id: fx.srcOpt, project_id: fx.projectId, signed: over.signed }), 201)
  return { sale, boss, src: res.body as Source }
}

/** POST JSON tới `/hooks/in/:token`. */
export const hook = (token: string, body: unknown, headers: Record<string, string> = {}): Promise<Res> => call('POST', `${HOOK}/${token}`, { body, headers, ip: freshIp() })

/** POST thân THÔ (chữ ký tính trên byte, text/plain, thân quá lớn): `call()` luôn `JSON.stringify` nên dùng fetch trực tiếp. */
export async function hookRaw(token: string, raw: string | Buffer, headers: Record<string, string>): Promise<Res> {
  const res = await fetch(`${config.baseUrl}${HOOK}/${token}`, { method: 'POST', headers: { 'x-real-ip': freshIp(), ...headers }, body: raw as BodyInit })
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    /* giữ chuỗi */
  }
  return { status: res.status, headers: res.headers, body }
}

export const signedHook = (token: string, secret: string, body: object, tOffsetSec = 0): Promise<Res> => {
  const raw = JSON.stringify(body)
  return hookRaw(token, raw, { 'content-type': 'application/json', 'x-trinity-signature': signHeader(secret, raw, Date.now() + tOffsetSec * 1000) })
}

export const lead = (phone = PHONES[0], extra: object = {}): Record<string, unknown> => ({ name: 'Khách Hook', phone, ...extra })

/** Khách có sẵn (SQL), `ownerId` là người sở hữu. */
export const existingContact = (phone: string, name: string, ownerId: number): Promise<number> => seedContact({ phone, name, ownerId })

/** Nguồn seed bằng SQL (hồ sơ tắt cờ / thiếu khoá không tạo được qua API): trả token thật để gọi `/hooks/in/:token`. */
export async function seedSourceSql(opts: { assigneeId: number; contactSourceId: number; createdBy: number; signingSecretEnc?: string | null; token?: string }): Promise<{ id: number; token: string }> {
  const token = opts.token ?? `whk_${Buffer.from(`inbound-${Date.now()}-${Math.random()}`).toString('base64url').padEnd(43, 'A').slice(0, 43)}`
  const [r] = await q<{ id: number }>(
    `INSERT INTO webhook_inbound_sources (name, token_hash, token_prefix, signing_secret_enc, default_assignee_id, contact_source_id, created_by, updated_at)
     VALUES ('Nguồn seed', $1, $2, $3, $4, $5, $6, now()) RETURNING id`,
    [sha256(token), token.slice(0, 12), opts.signingSecretEnc ?? null, opts.assigneeId, opts.contactSourceId, opts.createdBy],
  )
  return { id: r.id, token }
}

export const n = async (sql: string, params: unknown[] = []): Promise<number> => Number((await q<{ n: string | number }>(sql, params))[0].n)
