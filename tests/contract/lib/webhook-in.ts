import { createHash, createHmac } from 'node:crypto'
import { config } from './config.js'
import { recordCall } from './coverage.js'
import type { Res } from './http.js'

/** `X-Hub-Signature-256` của Meta: `sha256=` + HMAC-SHA256(thân thô, app secret). */
export const fbSign = (raw: string | Buffer, secret = config.facebookAppSecret): string => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`

/** `X-ZEvent-Signature` của Zalo: `mac=` + sha256(app_id + thân thô + timestamp + khoá OA), KHÔNG phải HMAC. */
export const zaloSign = (raw: string | Buffer, timestamp: string, o: { appId?: string; secret?: string } = {}): string =>
  `mac=${createHash('sha256')
    .update(o.appId ?? config.zaloAppId)
    .update(raw)
    .update(timestamp)
    .update(o.secret ?? config.zaloWebhookSecret)
    .digest('hex')}`

/** POST thân thô (đúng từng byte đã ký) tới đường công khai; không token, không `x-real-ip`. */
export async function postRaw(path: string, raw: string, headers: Record<string, string> = {}): Promise<Res> {
  const res = await fetch(`${config.baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw, redirect: 'manual' })
  recordCall('POST', path, res.status, false)
  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return { status: res.status, headers: res.headers, body }
}

const FB = '/api/v1/facebook/webhook'
const ZALO = '/api/v1/zalo-oa/webhook'

/** Gửi payload Facebook đã ký đúng bí mật của hồ sơ. */
export function fbPost(payload: unknown, extra: Record<string, string> = {}): Promise<Res> {
  const raw = JSON.stringify(payload)
  return postRaw(FB, raw, { 'x-hub-signature-256': fbSign(raw), ...extra })
}

export async function fbVerify(query: Record<string, string>): Promise<Res> {
  const res = await fetch(`${config.baseUrl}${FB}?${new URLSearchParams(query).toString()}`, { redirect: 'manual' })
  recordCall('GET', FB, res.status, false)
  const text = await res.text()
  let body: unknown = text || null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    /* challenge là chuỗi thô */
  }
  return { status: res.status, headers: res.headers, body }
}

/** Gửi sự kiện Zalo đã ký; `timestamp` lấy từ chính payload (như Zalo). */
export function zaloPost(payload: { timestamp?: unknown; [k: string]: unknown }, extra: Record<string, string> = {}): Promise<Res> {
  const raw = JSON.stringify(payload)
  return postRaw(ZALO, raw, { 'x-zevent-signature': zaloSign(raw, String(payload.timestamp ?? '')), ...extra })
}

export const FB_PATH = FB
export const ZALO_PATH = ZALO

// ───────────────────────────── dựng payload Facebook ─────────────────────────────

export const fbBatch = (...entries: Array<{ id: string; messaging?: unknown[]; changes?: unknown[] }>): unknown => ({
  object: 'page',
  entry: entries.map((e) => ({ time: Date.now(), ...e })),
})

/** Tin nhắn của khách tới Page. */
export const fbMessage = (page: string, psid: string, mid: string, message: Record<string, unknown> = { text: 'Xin chào' }): unknown =>
  fbBatch({ id: page, messaging: [{ sender: { id: psid }, recipient: { id: page }, timestamp: Date.now(), message: { mid, ...message } }] })

/** Echo: tin do chính Page gửi đi (người gửi là Page). */
export const fbEcho = (page: string, psid: string, mid: string, text: string): unknown =>
  fbBatch({ id: page, messaging: [{ sender: { id: page }, recipient: { id: psid }, timestamp: Date.now(), message: { mid, text, is_echo: true } }] })

/** Khách mở link/QR chat (`ref`) khi đã có hội thoại. */
export const fbReferral = (page: string, psid: string, ref: string): unknown =>
  fbBatch({ id: page, messaging: [{ sender: { id: psid }, recipient: { id: page }, timestamp: Date.now(), referral: { ref, source: 'SHORTLINK', type: 'OPEN_THREAD' } }] })

export const fbComment = (page: string, v: Record<string, unknown>): unknown =>
  fbBatch({ id: page, changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', created_time: Math.floor(Date.now() / 1000), ...v } }] })

export const fbLeadgen = (page: string, leadgenId: string, formId = '9001'): unknown =>
  fbBatch({ id: page, changes: [{ field: 'leadgen', value: { leadgen_id: leadgenId, page_id: page, form_id: formId, created_time: Math.floor(Date.now() / 1000) } }] })
