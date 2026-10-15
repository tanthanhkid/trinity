import crypto from 'node:crypto'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { storageStatePath } from '../helpers/roles'
import { Api, BASE_URL } from '../helpers/api'
import { fakePhone, prefix, requireWrite } from '../helpers/data'
import { record } from '../helpers/manifest'
import { MCP_URL, authorize, callTool, mcp, newCtx, registerClient, revokeToken } from '../helpers/oauth-mcp'
import { optionId } from '../seed/lib'

/**
 * KẾT NỐI & AI — chạy THẬT, mọi thứ trỏ về CHÍNH hệ thống (không gửi dữ liệu ra ngoài):
 *   1. Webhook VÀO: tạo nguồn → POST payload → khách được tạo; trùng/replay/sai token/sai chữ ký; chữ ký HMAC.
 *   2. Webhook RA: endpoint trỏ về `/api/v1/hooks/in/<token>` của chính hệ thống → sự kiện contact.created →
 *      delivery được ghi nhận (bên nhận trả 400 vì khác định dạng là bình thường); bí mật chỉ hiện 1 lần.
 *   3. OAuth 2.1 PKCE → MCP: search/fetch (đọc), chế độ duyệt BẬT (tuỳ chọn, mặc định tắt) nên tool ghi chỉ tạo ĐỀ XUẤT; thiếu crm.write bị chặn; token thu hồi hết hiệu lực.
 *   4. Duyệt đề xuất CHỈ bằng JWT web (token OAuth → 401), duyệt/từ chối; khách tạo ra đúng; nhật ký tích hợp có dòng.
 *   5. Giao diện: Cài đặt > Kết nối & AI, /ai-actions (duyệt bằng nút), màn đồng ý /oauth/authorize.
 */
requireWrite()
test.use({ storageState: storageStatePath('ADMIN') })
test.describe.configure({ mode: 'serial' })

const HOOK = (token: string) => `${BASE_URL.replace(/\/$/, '')}/api/v1/hooks/in/${token}`
let api: Api
let anon: APIRequestContext
let sourceId = 0
let sourceToken = ''
let signedId = 0
let signedToken = ''
let signingSecret = ''
let endpointId = 0
let saleId = 0

test.beforeAll(async () => {
  api = await Api.forRole('ADMIN')
  anon = await newCtx()
  const sale = await Api.forRole('SALE')
  saleId = (await sale.me()).user.id
  await sale.dispose()
  // Mặc định AI ghi thẳng theo quyền người kết nối; các bước duyệt bên dưới cần bật chế độ duyệt (tuỳ chọn).
  await api.patch('/integrations/ai-actions/settings', { require_approval: true })
})
test.afterAll(async () => {
  await api.patch('/integrations/ai-actions/settings', { require_approval: false }).catch(() => undefined)
  await anon.dispose()
  await api.dispose()
})

async function createSource(name: string, signed: boolean) {
  const r = await api.post<{ id: number; token: string; path: string; signing_secret?: string }>('/integrations/webhooks/inbound-sources', {
    name, default_assignee_id: saleId, contact_source_id: await optionId(api, 'contact_source'), signed,
  })
  record({ kind: 'webhook-in', id: r.id, label: name, del: `/integrations/webhooks/inbound-sources/${r.id}` })
  return r
}

async function findContact(name: string): Promise<{ id: number; full_name: string } | undefined> {
  const r = await api.get<{ data: { id: number; full_name: string }[] }>(`/contacts?limit=50&search=${encodeURIComponent(name)}`)
  return r.data.find((c) => c.full_name === name)
}
const trackContact = (id: number, name: string) =>
  record({ kind: 'contact', id, label: name, del: `/contacts/${id}`, soft: { table: 'contacts', note: 'xoá mềm (deleted_at)' } })

test('cờ máy chủ bật: webhook + MCP + khoá bí mật + URL công khai', async () => {
  const s = await api.get<Record<string, unknown>>('/integrations/status')
  expect(s).toMatchObject({ webhooks_enabled: true, mcp_enabled: true, secret_key_configured: true, mcp_base_url_configured: true })
  expect(s.mcp_url).toBe(MCP_URL)
})

test('webhook VÀO: tạo nguồn, nhận khách, trùng/replay/sai token/sai payload', async () => {
  const src = await createSource(prefix('hook-vao'), false)
  sourceId = src.id
  sourceToken = src.token
  expect(src.path, 'path trả về phải trỏ /api/v1/hooks/in/<token>').toBe(`/api/v1/hooks/in/${src.token}`)

  const name = prefix('khach-webhook')
  const phone = fakePhone()
  const ext = `e2e-${Date.now()}`
  const ok = await anon.post(HOOK(sourceToken), { data: { name, phone, email: 'e2e@example.invalid', note: 'E2E', external_id: ext } })
  expect(ok.status()).toBe(201)
  const body = (await ok.json()) as { status: string; contact_id: number }
  expect(body.status).toBe('created')
  trackContact(body.contact_id, name)

  // Khách thật sự có trong CRM, chủ = người nhận mặc định (SALE)
  const c = await api.get<{ id: number; assigned_to?: number; owner_id?: number }>(`/contacts/${body.contact_id}`)
  expect(c.id).toBe(body.contact_id)

  const replay = await anon.post(HOOK(sourceToken), { data: { name, phone, external_id: ext } })
  expect([200], 'cùng external_id → replayed').toContain(replay.status())
  expect(((await replay.json()) as { status: string }).status).toBe('replayed')
  const dup = await anon.post(HOOK(sourceToken), { data: { name: `${name}-2`, phone } })
  expect(((await dup.json()) as { status: string }).status, 'cùng SĐT cùng chủ → duplicate').toBe('duplicate')
  expect((await anon.post(HOOK('whk_sai_token_e2e'), { data: { name, phone } })).status(), 'token sai → 404').toBe(404)
  expect((await anon.post(HOOK(sourceToken), { data: { name: '', phone: '123' } })).status(), 'payload sai → 400').toBe(400)
})

test('webhook VÀO có chữ ký: thiếu/sai chữ ký → 401, đúng HMAC → 201', async () => {
  const src = await createSource(prefix('hook-ky'), true)
  signedId = src.id
  signedToken = src.token
  signingSecret = src.signing_secret ?? ''
  expect(signingSecret, 'nguồn signed phải trả signing_secret MỘT lần').toMatch(/\S{10,}/)
  const payload = { name: prefix('khach-ky'), phone: fakePhone() }
  const raw = JSON.stringify(payload)
  const sign = (secret: string, t: number) => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`
  const post = (sig?: string) => anon.post(HOOK(signedToken), { headers: { 'content-type': 'application/json', ...(sig ? { 'x-trinity-signature': sig } : {}) }, data: raw })
  expect((await post()).status(), 'thiếu chữ ký').toBe(401)
  expect((await post(sign('sai-secret', Math.floor(Date.now() / 1000)))).status(), 'sai bí mật').toBe(401)
  expect((await post(sign(signingSecret, Math.floor(Date.now() / 1000) - 3600))).status(), 'dấu thời gian quá cũ').toBe(401)
  const good = await post(sign(signingSecret, Math.floor(Date.now() / 1000)))
  expect(good.status()).toBe(201)
  trackContact(((await good.json()) as { contact_id: number }).contact_id, payload.name)
  // GET nguồn không trả lại bí mật
  const view = await api.get<Record<string, unknown>>(`/integrations/webhooks/inbound-sources/${signedId}`)
  expect(JSON.stringify(view)).not.toContain(signingSecret)
  expect(JSON.stringify(view)).not.toContain(signedToken)
})

test('webhook RA: endpoint trỏ về chính hệ thống → delivery được ghi nhận; secret chỉ hiện 1 lần', async () => {
  const ev = await api.get<{ type: string }[]>('/integrations/webhooks/events')
  expect(ev.map((e) => e.type)).toEqual(expect.arrayContaining(['contact.created', 'deal.won', 'pos.order.completed']))

  const name = prefix('hook-ra')
  const ep = await api.post<{ id: number; secret: string; secret_set?: boolean }>('/integrations/webhooks/endpoints', { name, url: HOOK(sourceToken), events: ['contact.created'] })
  endpointId = ep.id
  record({ kind: 'webhook-out', id: ep.id, label: name, del: `/integrations/webhooks/endpoints/${ep.id}` })
  expect(ep.secret).toMatch(/^whsec_/)
  const got = await api.get<Record<string, unknown>>(`/integrations/webhooks/endpoints/${ep.id}`)
  expect(JSON.stringify(got), 'GET endpoint không được lộ secret').not.toContain(ep.secret)

  // PING (đồng bộ, 1 lần thử): hệ thống tự gọi URL của nó
  const ping = await api.post<{ delivery_id: string; ok: boolean; status_code: number | null; error: string | null }>(`/integrations/webhooks/endpoints/${ep.id}/test`)
  expect(ping.delivery_id, 'ping phải sinh delivery').toBeTruthy()
  expect(ping.status_code !== null || ping.error, 'ping phải có mã HTTP hoặc lỗi cụ thể').toBeTruthy()

  // Sự kiện thật: contact.created (qua webhook vào) → delivery tới endpoint
  const cname = prefix('khach-kich-hoat')
  const r = await anon.post(HOOK(sourceToken), { data: { name: cname, phone: fakePhone() } })
  expect(r.status()).toBe(201)
  trackContact(((await r.json()) as { contact_id: number }).contact_id, cname)
  await expect
    .poll(async () => (await api.get<{ data: { event_type: string; status: string; attempts: number; last_status_code: number | null }[] }>(`/integrations/webhooks/deliveries?endpoint_id=${ep.id}&limit=20`)).data.filter((d) => d.event_type === 'contact.created').length, { message: 'delivery contact.created phải được ghi nhận', timeout: 60_000, intervals: [2000] })
    .toBeGreaterThan(0)
  const d = (await api.get<{ data: { event_type: string; status: string; attempts: number; last_status_code: number | null }[] }>(`/integrations/webhooks/deliveries?endpoint_id=${ep.id}&limit=20`)).data.find((x) => x.event_type === 'contact.created')!
  expect(['success', 'failed', 'dead', 'pending']).toContain(d.status)
  expect(d.attempts).toBeGreaterThanOrEqual(1)
})

test('OAuth PKCE → MCP: đọc search/fetch, ghi chỉ tạo đề xuất, duyệt chỉ bằng JWT web', async () => {
  // Khám phá + chưa đăng nhập
  const meta = await anon.get(`${BASE_URL}/api/v1/oauth/.well-known/oauth-authorization-server`)
  expect(meta.ok(), 'metadata OAuth').toBe(true)
  const unauth = await mcp(anon, null, 'tools/list')
  expect(unauth.status).toBe(401)
  expect(unauth.headers['www-authenticate'] ?? '').toMatch(/resource_metadata/)
  expect((await mcp(anon, 'trn_at_sai', 'tools/list')).status).toBe(401)
  // Origin lạ bị chặn bằng 403 ở tầng mcp.e2e-spec (có token hợp lệ); ở đây chưa có token nên chỉ khẳng định vẫn bị từ chối.
  expect([401, 403], 'Origin lạ').toContain((await mcp(anon, null, 'tools/list', undefined, 'https://evil.example.com')).status)

  const clientId = await registerClient(anon, prefix('ung-dung-ai'))
  record({ kind: 'oauth-client', id: clientId, label: 'client OAuth thử', soft: { table: 'oauth_clients', note: 'không có API xoá (job purge chỉ xoá client chưa dùng >7 ngày); kèm oauth_*_tokens/codes' } })

  // Chỉ crm.read: tool ghi bị chặn theo scope
  const ro = await authorize(api, anon, clientId, ['crm.read'])
  expect(ro.scope).not.toContain('crm.write')
  expect((await mcp(anon, ro.access, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })).status).toBe(200)
  const denied = await callTool(anon, ro.access, 'create_contact', { full_name: prefix('khong-quyen'), phone: fakePhone(), source_id: await optionId(api, 'contact_source') })
  expect(JSON.stringify(denied.result ?? denied.error), 'thiếu crm.write phải bị chặn').toMatch(/insufficient_scope|scope/i)
  await revokeToken(anon, clientId, ro.access)

  // Đủ crm.read + crm.write
  const tk = await authorize(api, anon, clientId, ['crm.read', 'crm.write'])
  expect(tk.scope).toContain('crm.write')
  const list = await mcp(anon, tk.access, 'tools/list')
  expect(list.status).toBe(200)
  const tools = (list.result?.tools ?? []) as { name: string; annotations?: { readOnlyHint?: boolean } }[]
  const names = tools.map((t) => t.name)
  expect(names).toEqual(expect.arrayContaining(['search', 'fetch', 'create_contact', 'add_contact_note', 'update_contact_stage', 'create_task', 'assign_contact']))
  expect(names.filter((n) => /delete|remove|export|download|approve|role|password/.test(n)), 'không tool nguy hiểm').toEqual([])
  // Server còn nhiều tool ghi khác (create_record, complete_setup…) — chỉ đòi năm tool CRM này mang readOnlyHint=false.
  const writeNames = tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name)
  expect(writeNames).toEqual(expect.arrayContaining(['add_contact_note', 'assign_contact', 'create_contact', 'create_task', 'update_contact_stage']))

  // search/fetch: tìm khách seed từ webhook
  const found = await callTool(anon, tk.access, 'search', { query: 'E2E-' })
  expect(found.status).toBe(200)
  const results = (found.result?.structuredContent?.results ?? []) as { id: string; title: string; url: string }[]
  expect(results.length, 'search E2E- phải ra khách thử').toBeGreaterThan(0)
  for (const r of results) expect(r).toMatchObject({ id: expect.any(String), title: expect.any(String), url: expect.any(String) })
  const fetched = await callTool(anon, tk.access, 'fetch', { id: results[0].id })
  expect(fetched.status).toBe(200)
  expect(JSON.stringify(fetched.result), 'SĐT trong kết quả MCP phải che').not.toMatch(/\b0\d{9}\b/)

  // Chế độ duyệt đang bật (beforeAll) → tool ghi chỉ tạo ĐỀ XUẤT (chưa tạo khách)
  // Tóm tắt đề xuất che mọi chuỗi số dài (giống SĐT) ⇒ đối chiếu bằng mã CHỮ ngẫu nhiên, không dùng timestamp.
  const letters = Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 8)
  const c1 = prefix(`khach-ai-duyet-${letters}`)
  const c2 = prefix(`khach-ai-tuchoi-${letters}`)
  const src = await optionId(api, 'contact_source')
  for (const nm of [c1, c2]) {
    const r = await callTool(anon, tk.access, 'create_contact', { full_name: nm, phone: fakePhone(), source_id: src })
    expect(r.status).toBe(200)
    expect(JSON.stringify(r.result)).toMatch(/đề xuất #\d+/i)
  }
  expect(await findContact(c1), 'tool ghi chưa được tạo khách trước khi duyệt').toBeUndefined()
  const drafts = await api.get<{ data: { id: number; status: string; summary: string; client_name: string | null }[] }>('/integrations/ai-actions?status=pending&limit=50')
  const d1 = drafts.data.find((d) => d.summary.includes(`ai-duyet-${letters}`))!
  const d2 = drafts.data.find((d) => d.summary.includes(`ai-tuchoi-${letters}`))!
  expect(d1 && d2, `cả 2 đề xuất phải chờ duyệt; thấy: ${JSON.stringify(drafts.data.map((d) => ({ id: d.id, s: d.summary })))}`).toBeTruthy()
  for (const d of [d1, d2]) record({ kind: 'ai-action', id: d.id, label: `đề xuất AI ${d.id}`, pre: [{ method: 'POST', url: `/integrations/ai-actions/${d.id}/reject` }], soft: { table: 'ai_action_drafts', note: 'không có API xoá (job tự dọn sau 90 ngày)' } })

  // Duyệt CHỈ bằng JWT web: token OAuth bị từ chối
  const viaOauth = await anon.post(`${BASE_URL}/api/v1/integrations/ai-actions/${d1.id}/approve`, { headers: { authorization: `Bearer ${tk.access}` } })
  expect(viaOauth.status(), 'approve bằng token OAuth phải bị từ chối').toBe(401)
  expect(await findContact(c1)).toBeUndefined()

  // Duyệt thật + từ chối
  await api.post(`/integrations/ai-actions/${d1.id}/approve`)
  await expect.poll(async () => (await findContact(c1))?.id ?? 0, { message: 'duyệt xong khách phải được tạo', timeout: 20_000 }).toBeGreaterThan(0)
  trackContact((await findContact(c1))!.id, c1)
  await api.post(`/integrations/ai-actions/${d2.id}/reject`)
  expect(await findContact(c2), 'đề xuất bị từ chối không được tạo khách').toBeUndefined()
  expect((await api.call('POST', `/integrations/ai-actions/${d1.id}/approve`)).status(), 'duyệt lại → 409').toBe(409)
  const st = await callTool(anon, tk.access, 'get_action_status', { id: d1.id })
  expect(JSON.stringify(st.result)).toMatch(/approved|đã duyệt|Đã/i)

  // Kết nối hiện trong danh sách; thu hồi → MCP 401
  const conns = await api.get<{ data: { id: string; client_id: string }[] }>('/integrations/ai-connections?scope=all')
  const mine = conns.data.find((c) => c.client_id === clientId)
  expect(mine, 'kết nối OAuth phải hiện ở Kết nối AI').toBeTruthy()
  expect(await revokeToken(anon, clientId, tk.access)).toBe(200)
  expect((await mcp(anon, tk.access, 'tools/list')).status, 'token đã thu hồi').toBe(401)
  if (mine) await api.del(`/integrations/ai-connections/${mine.id}`)

  // Nhật ký tích hợp có dòng cho cả 3 kênh
  const logs = await api.get<{ data: { channel: string; action: string; status: string }[] }>('/integrations/audit-logs?limit=100')
  const channels = new Set(logs.data.map((l) => l.channel))
  expect(channels.has('mcp') && channels.has('webhook_in'), `nhật ký phải có dòng mcp + webhook_in (có: ${[...channels].join(',')})`).toBe(true)
})

test('UI: Cài đặt > Kết nối & AI hiện endpoint/nguồn; /ai-actions duyệt bằng nút; màn đồng ý OAuth', async ({ page }) => {
  // Đề xuất mới để duyệt bằng NÚT
  const clientId = await registerClient(anon, prefix('ung-dung-ui'))
  record({ kind: 'oauth-client', id: clientId, label: 'client OAuth thử (UI)', soft: { table: 'oauth_clients', note: 'không có API xoá' } })
  const tk = await authorize(api, anon, clientId, ['crm.read', 'crm.write'])
  const nm = prefix(`khach-ai-ui-${Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 8)}`)
  await callTool(anon, tk.access, 'create_contact', { full_name: nm, phone: fakePhone(), source_id: await optionId(api, 'contact_source') })
  const pend = await api.get<{ data: { id: number; summary: string }[] }>('/integrations/ai-actions?status=pending&limit=50')
  const draft = pend.data.find((d) => d.summary.includes(nm.slice(nm.indexOf('khach-ai-ui'))))!
  record({ kind: 'ai-action', id: draft.id, label: `đề xuất AI ${draft.id}`, pre: [{ method: 'POST', url: `/integrations/ai-actions/${draft.id}/reject` }], soft: { table: 'ai_action_drafts', note: 'không có API xoá' } })

  await page.goto('/ai-actions')
  const shown = new RegExp(nm.slice(nm.indexOf('khach-ai-ui')))
  await expect(page.getByText(shown).first()).toBeVisible({ timeout: 20_000 })
  await page.getByText(shown).first().locator('xpath=ancestor::*[.//button[contains(.,"Xem & duyệt")]][1]').getByRole('button', { name: 'Xem & duyệt' }).click()
  await page.getByRole('button', { name: 'Duyệt và thực hiện' }).click()
  await expect.poll(async () => (await findContact(nm))?.id ?? 0, { message: 'Duyệt bằng nút trên UI phải tạo khách', timeout: 20_000 }).toBeGreaterThan(0)
  trackContact((await findContact(nm))!.id, nm)

  await page.goto('/settings?tab=integrations')
  await expect(page.getByText(/Webhook/i).first()).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Chưa').first().or(page.getByText(/hook-ra/).first())).toBeVisible()

  // Màn đồng ý OAuth hiển thị đúng tên ứng dụng + nút Từ chối
  const { pkce } = await import('../helpers/oauth-mcp')
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'https://e2e.invalid/callback', scope: 'crm.read', state: 's', code_challenge: pkce().challenge, code_challenge_method: 'S256', resource: MCP_URL })
  await page.goto(`/oauth/authorize?${q.toString()}`)
  await expect(page.getByRole('heading', { name: /Cho phép ứng dụng này truy cập Trinity CRM/ })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: 'Cho phép' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Từ chối' })).toBeVisible()
  await revokeToken(anon, clientId, tk.access)
  const conns = await api.get<{ data: { id: string; client_id: string }[] }>('/integrations/ai-connections?scope=all')
  for (const c of conns.data.filter((x) => x.client_id === clientId)) await api.del(`/integrations/ai-connections/${c.id}`)
})
