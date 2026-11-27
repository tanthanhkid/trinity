import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, q } from '../../lib/db.js'
import { api, call as httpCall, control, freshIp } from '../../lib/http.js'
import { callTool, connect, makeUser, mkContact as mk, option, rpc, TRUNCATE_OAUTH, BASE, MCP, REDIRECT } from '../../lib/mcp.js'
import { createHash } from 'node:crypto'

/**
 * Chuyển từ `apps/monolith/test/rbac/ai-actions.e2e-spec.ts` (26 ca) sang hộp đen: AI ghi qua MCP, chế độ "duyệt" (nháp → người dùng
 * duyệt bằng JWT phiên web) và "ghi thẳng". Seed/kiểm bằng SQL; hết hạn nháp ⇒ API điều khiển `jobs/ai-action-expiry/run`; xoá giới hạn tốc độ và
 * cache quyền ⇒ `cache/flush`. Ca "cờ tắt ⇒ 404" nằm ở hồ sơ `integrations-off`.
 */
const P = 'E2E-ACT'
const ACTIONS = '/integrations/ai-actions'
const FULL_PHONE = '0987654321'
const APPROVAL_KEY = 'ai_require_approval'
const WRITER = { 'integrations.ai_connect': true, 'contacts.view': 'own', 'contacts.create': true, 'contacts.update': 'own', 'contacts.transfer': 'team', 'kanban.view': 'own', 'kanban.manage': 'own' } as const

let sourceId = 0
let stageA = 0
let stageB = 0

const mkContact = (name: string, o: { assigned_to?: number; created_by_id?: number } = {}) => mk(P, name, { ...o, stage_id: stageA })
const setApproval = (on: boolean) =>
  on
    ? q(`INSERT INTO settings (key, value, updated_at) VALUES ($1, 'true', now()) ON CONFLICT (key) DO UPDATE SET value = 'true'`, [APPROVAL_KEY])
    : q(`DELETE FROM settings WHERE key = $1`, [APPROVAL_KEY])
const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await q<{ n: string }>(`SELECT count(*) AS n FROM ${sql}`, params))[0].n)

const propose = async (access: string, name: string, args: Record<string, unknown>): Promise<number> => {
  const r = await callTool(access, name, args)
  expect({ err: r.isError, text: r.isError ? r.content[0].text : '' }).toEqual({ err: undefined, text: '' })
  return r.structuredContent.data.action_id as number
}
const approve = (token: string, id: number) => httpCall('POST', `/api/v1${ACTIONS}/${id}/approve`, { token, ip: freshIp() })
const reject = (token: string, id: number) => httpCall('POST', `/api/v1${ACTIONS}/${id}/reject`, { token, ip: freshIp() })
const getAction = (token: string, id: number | string) => api.get(`${ACTIONS}/${id}`, { token, ip: freshIp() })
const draftStatus = async (id: number): Promise<{ status: string; error: string | null }> => (await q<{ status: string; error: string | null }>(`SELECT status, error FROM ai_action_drafts WHERE id = $1`, [id]))[0]
const ok = <T>(r: { status: number; body: unknown }, status = 200): T => {
  expect(r.status).toBe(status)
  return r.body as T
}

beforeAll(async () => {
  sourceId = await option('contact_source', 'e2e_act_src')
  stageA = await option('contact_stage', 'e2e_act_a')
  stageB = await option('contact_stage', 'e2e_act_b')
})
// Các nhóm (trừ "ghi thẳng") kiểm luồng nháp → duyệt ⇒ bật chế độ duyệt; nhóm ghi thẳng tự tắt lại.
beforeEach(async () => {
  await setApproval(true)
  await q(`DELETE FROM kanban_boards WHERE name LIKE '${P}%'`)
  await q(`DELETE FROM activities WHERE contact_id IN (SELECT id FROM contacts WHERE full_name LIKE '${P}%')`)
  await q(`DELETE FROM contacts WHERE full_name LIKE '${P}%'`)
  await q(TRUNCATE_OAUTH)
  expect((await control.flushCache()).status).toBe(200)
})
afterAll(async () => {
  await setApproval(false)
  await closeDb()
})

describe('luồng chính: tạo nháp → duyệt', () => {
  it('create_contact: nháp KHÔNG ghi; duyệt bằng JWT web ⇒ khách + outbox contact.created; AI hỏi get_action_status; SĐT đầy đủ không lộ', async () => {
    const u = await makeUser({ ...WRITER })
    const t = await connect(u.token, 'crm.read crm.write')
    expect(t.scopes).toEqual(['crm.read', 'crm.write'])
    const r = await callTool(t.access, 'create_contact', { full_name: `${P} Trần Thị Nháp`, phone: FULL_PHONE, source_id: sourceId, stage_id: stageA })
    expect(r.isError).toBeUndefined()
    const d = r.structuredContent.data
    expect(d).toMatchObject({ status: 'pending', duplicate: false })
    expect(d.review_url).toBe(`${BASE}/ai-actions?id=${d.action_id}`)
    expect(d.message).toContain(`Đã tạo đề xuất #${d.action_id}, chờ người dùng duyệt`)
    expect(JSON.stringify(r)).not.toContain(FULL_PHONE)
    expect(d.summary).toContain('***321')
    expect(await count(`contacts WHERE full_name = '${P} Trần Thị Nháp'`)).toBe(0)
    expect(await count(`integration_events WHERE event_type = 'contact.created'`)).toBe(0)
    const noti = await q<{ action_url: string; body: string }>(`SELECT action_url, body FROM notification_logs WHERE recipient_id = $1 AND event_type = 'ai_action.created'`, [u.id])
    expect(noti).toHaveLength(1)
    expect(noti[0].action_url).toBe(`/ai-actions?id=${d.action_id}`)
    expect(noti[0].body).not.toContain(FULL_PHONE)
    expect(await count(`integration_audit_logs WHERE action = 'ai_action.draft'`)).toBe(1)

    expect((await callTool(t.access, 'get_action_status', { id: d.action_id })).structuredContent.data.status).toBe('pending')
    const list = ok<{ data: Record<string, unknown>[] }>(await api.get(ACTIONS, { token: u.token, ip: freshIp() }))
    expect(list.data).toHaveLength(1)
    expect(JSON.stringify(list)).not.toContain(FULL_PHONE)
    expect(list.data[0]).not.toHaveProperty('params')
    expect(list.data[0]).toMatchObject({ tool: 'create_contact', status: 'pending', client_name: 'ChatGPT e2e' })
    expect(ok(await api.get(`${ACTIONS}/pending-count`, { token: u.token, ip: freshIp() }))).toEqual({ pending: 1 })

    const done = ok<{ status: string; result: { contact_id: number } }>(await approve(u.token, d.action_id))
    expect(done.status).toBe('approved')
    const contactId = done.result.contact_id
    const c = (await q<Record<string, unknown>>(`SELECT * FROM contacts WHERE id = $1`, [contactId]))[0]
    expect(c).toMatchObject({ full_name: `${P} Trần Thị Nháp`, phone: FULL_PHONE, assigned_to: u.id, source_id: sourceId })
    const ev = await q<{ resource_id: string; actor_user_id: number }>(`SELECT resource_id, actor_user_id FROM integration_events WHERE event_type = 'contact.created'`)
    expect(ev).toHaveLength(1)
    expect(String(ev[0].resource_id)).toBe(String(contactId))
    expect(ev[0].actor_user_id).toBe(u.id)
    expect(await count(`integration_audit_logs WHERE action = 'ai_action.approve' AND status = 'ok'`)).toBe(1)
    const st2 = await callTool(t.access, 'get_action_status', { id: d.action_id })
    expect(st2.structuredContent.data).toMatchObject({ status: 'approved', result: { contact_id: contactId } })
    expect(JSON.stringify(st2)).not.toContain(FULL_PHONE)
    expect((await approve(u.token, d.action_id)).status).toBe(409)
    expect(await count(`contacts WHERE full_name = '${P} Trần Thị Nháp'`)).toBe(1)
  })

  it('add_contact_note / update_contact_stage / assign_contact / create_task: duyệt ⇒ activity, outbox contact.stage_changed + contact.assigned, thẻ giao cho NGƯỜI DUYỆT', async () => {
    const boss = await makeUser({ 'contacts.view': 'all' })
    const u = await makeUser({ ...WRITER, 'contacts.view': 'own' })
    const mate = await makeUser({ 'contacts.view': 'own' }, { managerId: u.id })
    const t = await connect(u.token, 'crm.read crm.write')
    const mine = await mkContact('Của tôi', { assigned_to: u.id })
    const [board] = await q<{ id: number }>(`INSERT INTO kanban_boards (name) VALUES ($1) RETURNING id`, [`${P} bảng`])
    const [col] = await q<{ id: number }>(`INSERT INTO kanban_columns (board_id, name, position) VALUES ($1, 'Mới', 1), ($1, 'Xong', 2) RETURNING id`, [board.id])

    const note = await propose(t.access, 'add_contact_note', { contact_id: mine.id, note: 'Khách hẹn liên hệ lại <img src=x onerror=alert(1)> 0912345678' })
    const stage = await propose(t.access, 'update_contact_stage', { contact_id: mine.id, stage_id: stageB })
    const assign = await propose(t.access, 'assign_contact', { contact_id: mine.id, new_assigned_to: mate.id, reason: 'Nghỉ phép' })
    const task = await propose(t.access, 'create_task', { title: 'Liên hệ lại khách', due_at: '2026-12-01T09:00:00Z', priority: 'high', contact_id: mine.id, column_id: col.id, assignee_id: boss.id, assignee_ids: [boss.id] })

    const draft = ok<{ summary: string; details: { value: string }[] }>(await getAction(u.token, note))
    expect(draft.summary).not.toContain('0912345678')
    expect(JSON.stringify(draft.details)).not.toContain('0912345678')
    expect(draft.details.some((l) => l.value.includes('<img'))).toBe(true) // dữ liệu thuần: FE hiển thị bằng text

    expect((await approve(u.token, note)).status).toBe(200)
    const act = await q<{ created_by: number }>(`SELECT created_by FROM activities WHERE contact_id = $1 AND action = 'note'`, [mine.id])
    expect(act).toHaveLength(1)
    expect(act[0].created_by).toBe(u.id)

    expect((await approve(u.token, stage)).status).toBe(200)
    expect((await q<{ stage_id: number }>(`SELECT stage_id FROM contacts WHERE id = $1`, [mine.id]))[0].stage_id).toBe(stageB)
    expect(await count(`integration_events WHERE event_type = 'contact.stage_changed'`)).toBe(1)

    expect((await approve(u.token, task)).status).toBe(200)
    const card = (await q<{ id: number; created_by: number; contact_id: number }>(`SELECT id, created_by, contact_id FROM kanban_cards WHERE title = 'Liên hệ lại khách'`))[0]
    expect(card.created_by).toBe(u.id)
    expect((await q<{ user_id: number }>(`SELECT user_id FROM kanban_card_assignees WHERE card_id = $1`, [card.id])).map((a) => a.user_id)).toEqual([u.id]) // KHÔNG theo assignee của AI
    expect(card.contact_id).toBe(mine.id)

    expect((await approve(u.token, assign)).status).toBe(200)
    expect((await q<{ assigned_to: number }>(`SELECT assigned_to FROM contacts WHERE id = $1`, [mine.id]))[0].assigned_to).toBe(mate.id)
    expect(await count(`integration_events WHERE event_type = 'contact.assigned'`)).toBe(1)
  })

  it('từ chối ⇒ rejected, không ghi; không duyệt được nữa', async () => {
    const u = await makeUser({ ...WRITER })
    const t = await connect(u.token, 'crm.read crm.write')
    const mine = await mkContact('Từ chối', { assigned_to: u.id })
    const id = await propose(t.access, 'add_contact_note', { contact_id: mine.id, note: 'x' })
    const r = ok<{ status: string }>(await reject(u.token, id))
    expect(r.status).toBe('rejected')
    expect(await count(`activities WHERE contact_id = $1 AND action = 'note'`, [mine.id])).toBe(0)
    expect((await approve(u.token, id)).status).toBe(409)
    expect((await reject(u.token, id)).status).toBe(409)
    expect((await callTool(t.access, 'get_action_status', { id })).structuredContent.data.status).toBe('rejected')
  })

  it('trùng tham số đang chờ ⇒ trả lại cùng nháp (duplicate), không nhân bản', async () => {
    const u = await makeUser({ ...WRITER })
    const t = await connect(u.token, 'crm.read crm.write')
    const mine = await mkContact('Trùng', { assigned_to: u.id })
    const a = await callTool(t.access, 'add_contact_note', { contact_id: mine.id, note: 'giống nhau' })
    const b = await callTool(t.access, 'add_contact_note', { contact_id: mine.id, note: 'giống nhau' })
    expect(b.structuredContent.data.action_id).toBe(a.structuredContent.data.action_id)
    expect(b.structuredContent.data.duplicate).toBe(true)
    expect(await count('ai_action_drafts')).toBe(1)
    expect(await count(`notification_logs WHERE recipient_id = $1 AND event_type = 'ai_action.created'`, [u.id])).toBe(1)
  })
})

describe('quyền + phạm vi (lúc tạo nháp VÀ lúc duyệt)', () => {
  it('thiếu contacts.create ⇒ tool lỗi rõ ràng, KHÔNG có nháp; thiếu scope crm.write ⇒ insufficient_scope', async () => {
    const noCreate = await makeUser({ 'integrations.ai_connect': true, 'contacts.view': 'own' })
    const t1 = await connect(noCreate.token, 'crm.read crm.write')
    const r = await callTool(t1.access, 'create_contact', { full_name: `${P} Không quyền`, phone: FULL_PHONE, source_id: sourceId })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('contacts.create')
    expect(await count('ai_action_drafts')).toBe(0)
    expect(await count(`integration_audit_logs WHERE action = 'create_contact' AND status = 'denied'`)).toBe(1)

    const readOnly = await makeUser({ ...WRITER })
    const t2 = await connect(readOnly.token, 'crm.read crm.write', { granted: ['crm.read'] }) // người dùng BỎ tick quyền ghi ở màn đồng ý
    expect(t2.scopes).toEqual(['crm.read'])
    const r2 = await callTool(t2.access, 'create_contact', { full_name: `${P} Chỉ đọc`, phone: FULL_PHONE, source_id: sourceId })
    expect(r2.isError).toBe(true)
    expect(r2.content[0].text).toContain('insufficient_scope')
    expect(await count('ai_action_drafts')).toBe(0)
    expect((await callTool(t2.access, 'list_contacts')).isError).toBeUndefined()
  })

  it('ngoài phạm vi / tham số sai ⇒ lỗi sớm, không nháp: khách người khác, người nhận ngoài scope, nguồn sai, SĐT sai, cột không thấy', async () => {
    const other = await makeUser({ 'contacts.view': 'own' })
    const u = await makeUser({ ...WRITER })
    const t = await connect(u.token, 'crm.read crm.write')
    const theirs = await mkContact('Người khác', { assigned_to: other.id })
    const mine = await mkContact('Của tôi', { assigned_to: u.id })
    const stranger = await makeUser({ 'contacts.view': 'own' })
    const cases: [string, Record<string, unknown>][] = [
      ['add_contact_note', { contact_id: theirs.id, note: 'x' }],
      ['update_contact_stage', { contact_id: theirs.id, stage_id: stageB }],
      ['update_contact_stage', { contact_id: mine.id, stage_id: 999999 }],
      ['assign_contact', { contact_id: mine.id, new_assigned_to: stranger.id }], // ngoài scope contacts.transfer 'team'
      ['assign_contact', { contact_id: theirs.id, new_assigned_to: u.id }],
      ['create_contact', { full_name: 'A', phone: '123', source_id: sourceId }],
      ['create_contact', { full_name: 'A', phone: FULL_PHONE, source_id: stageA }], // sai nhóm
      ['create_task', { title: 'x', column_id: 999999 }],
    ]
    for (const [name, args] of cases) {
      const r = await callTool(t.access, name, args)
      expect({ name, isError: r.isError }).toEqual({ name, isError: true })
    }
    expect(await count('ai_action_drafts')).toBe(0)
  })

  it('quyền bị gỡ GIỮA CHỪNG ⇒ duyệt thất bại có lý do, không ghi; nháp chuyển failed', async () => {
    const u = await makeUser({ ...WRITER })
    const t = await connect(u.token, 'crm.read crm.write')
    const id = await propose(t.access, 'create_contact', { full_name: `${P} Mất quyền`, phone: FULL_PHONE, source_id: sourceId })
    await q(`DELETE FROM role_permissions WHERE role_id IN (SELECT role_id FROM user_roles WHERE user_id = $1) AND permission = 'contacts.create'`, [u.id])
    expect((await control.flushCache()).status).toBe(200)
    const r = await approve(u.token, id)
    expect(r.status).toBe(403)
    expect(JSON.stringify(r.body)).toContain('contacts.create')
    expect(await count(`contacts WHERE full_name = '${P} Mất quyền'`)).toBe(0)
    const row = await draftStatus(id)
    expect(row.status).toBe('failed')
    expect(row.error).toContain('contacts.create')
    const st = (await callTool(t.access, 'get_action_status', { id })).structuredContent.data
    expect(st).toMatchObject({ status: 'failed' })
    expect(JSON.stringify(st)).not.toContain('contacts.create') // lý do chi tiết chỉ người duyệt thấy (không thành oracle cho AI)
  })

  it('khách bị chuyển ra ngoài phạm vi sau khi tạo nháp ⇒ duyệt thất bại 404, không ghi', async () => {
    const other = await makeUser({ 'contacts.view': 'own' })
    const u = await makeUser({ ...WRITER })
    const t = await connect(u.token, 'crm.read crm.write')
    const c = await mkContact('Đổi chủ', { assigned_to: u.id })
    const id = await propose(t.access, 'add_contact_note', { contact_id: c.id, note: 'ghi chú' })
    await q(`UPDATE contacts SET assigned_to = $1 WHERE id = $2`, [other.id, c.id])
    expect((await approve(u.token, id)).status).toBe(404)
    expect((await approve(u.token, 99999999999)).status).toBe(404) // id ngoài INT32 không gây 500
    expect(await count(`activities WHERE contact_id = $1 AND action = 'note'`, [c.id])).toBe(0)
    expect((await draftStatus(id)).status).toBe('failed')
  })
})

describe('không có đường nào để AI tự duyệt', () => {
  it('token OAuth gọi route duyệt/xem/từ chối/danh sách ⇒ 401; người khác duyệt/xem/từ chối ⇒ 404', async () => {
    const u = await makeUser({ ...WRITER })
    const t = await connect(u.token, 'crm.read crm.write')
    const mine = await mkContact('Tự duyệt', { assigned_to: u.id })
    const id = await propose(t.access, 'add_contact_note', { contact_id: mine.id, note: 'AI đừng tự duyệt' })
    const bearer = (m: string, p: string) => httpCall(m, `/api/v1${p}`, { token: t.access, ip: freshIp() })
    expect((await bearer('POST', `${ACTIONS}/${id}/approve`)).status).toBe(401)
    expect((await bearer('POST', `${ACTIONS}/${id}/reject`)).status).toBe(401)
    expect((await bearer('GET', ACTIONS)).status).toBe(401)
    expect((await bearer('GET', `${ACTIONS}/${id}`)).status).toBe(401)
    expect((await httpCall('POST', `/api/v1${ACTIONS}/${id}/approve`, { ip: freshIp() })).status).toBe(401)
    expect(await count(`activities WHERE contact_id = $1 AND action = 'note'`, [mine.id])).toBe(0)
    expect((await draftStatus(id)).status).toBe('pending')

    const intruder = await makeUser({ ...WRITER })
    expect((await approve(intruder.token, id)).status).toBe(404)
    expect((await reject(intruder.token, id)).status).toBe(404)
    expect((await getAction(intruder.token, id)).status).toBe(404)
    expect(ok<{ data: unknown[] }>(await api.get(ACTIONS, { token: intruder.token, ip: freshIp() })).data).toEqual([])
    expect((await draftStatus(id)).status).toBe('pending')
  })

  it('2 yêu cầu duyệt SONG SONG ⇒ đúng 1 thắng, thực thi đúng 1 lần', async () => {
    const u = await makeUser({ ...WRITER })
    const t = await connect(u.token, 'crm.read crm.write')
    const id = await propose(t.access, 'create_contact', { full_name: `${P} Song song`, phone: FULL_PHONE, source_id: sourceId })
    const rs = await Promise.all([approve(u.token, id), approve(u.token, id), approve(u.token, id)])
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409])
    expect(await count(`contacts WHERE full_name = '${P} Song song'`)).toBe(1)
    expect(await count(`integration_events WHERE event_type = 'contact.created'`)).toBe(1)
  })

  it('nháp quá 24 giờ ⇒ không duyệt được (409), hiển thị expired; job hết hạn chạy được', async () => {
    const u = await makeUser({ ...WRITER })
    const t = await connect(u.token, 'crm.read crm.write')
    const mine = await mkContact('Hết hạn', { assigned_to: u.id })
    const id = await propose(t.access, 'add_contact_note', { contact_id: mine.id, note: 'sẽ hết hạn' })
    const id2 = await propose(t.access, 'add_contact_note', { contact_id: mine.id, note: 'sẽ hết hạn (2)' })
    await q(`UPDATE ai_action_drafts SET expires_at = now() - interval '1 minute'`)
    expect(ok<{ status: string }>(await getAction(u.token, id)).status).toBe('expired') // job chưa chạy vẫn đúng
    expect(ok<{ data: unknown[] }>(await api.get(`${ACTIONS}?status=expired`, { token: u.token, ip: freshIp() })).data).toHaveLength(2)
    expect(ok(await api.get(`${ACTIONS}/pending-count`, { token: u.token, ip: freshIp() }))).toEqual({ pending: 0 })
    const r = await approve(u.token, id)
    expect(r.status).toBe(409)
    expect(JSON.stringify(r.body)).toContain('hết hạn')
    expect(await count(`activities WHERE contact_id = $1 AND action = 'note'`, [mine.id])).toBe(0)
    const job = await control.runJob('ai-action-expiry')
    expect(job.status).toBe(200)
    expect((job.body as { result: unknown }).result).toMatchObject({ expired: 1 }) // id2 còn 'pending' trong DB (id đã được đánh dấu khi duyệt hụt)
    expect((await draftStatus(id2)).status).toBe('expired')
  })
})

describe('chống lạm dụng', () => {
  it('trần 50 đề xuất chờ/user và 10 đề xuất/phút (prompt injection tạo hàng loạt) — user khác không bị ảnh hưởng', async () => {
    const u = await makeUser({ ...WRITER })
    const v = await makeUser({ ...WRITER })
    const t = await connect(u.token, 'crm.read crm.write')
    const mine = await mkContact('Hàng loạt', { assigned_to: u.id })
    for (let i = 0; i < 10; i += 1) await propose(t.access, 'add_contact_note', { contact_id: mine.id, note: `ghi chú ${i}` })
    const over = await callTool(t.access, 'add_contact_note', { contact_id: mine.id, note: 'ghi chú 11' })
    expect(over.isError).toBe(true)
    expect(over.content[0].text).toContain('quá nhanh')
    for (let i = 0; i < 40; i += 1) {
      await q(`INSERT INTO ai_action_drafts (user_id, client_id, tool, params, summary, expires_at) VALUES ($1, $2, 'add_contact_note', $3::jsonb, 'x', now() + interval '1 hour')`, [u.id, `other-app-${i % 2}`, JSON.stringify({ contact_id: mine.id, note: `fill ${i}` })])
    }
    expect((await control.flushCache()).status).toBe(200) // thay `McpRateLimiter.reset()`
    const full = await callTool(t.access, 'add_contact_note', { contact_id: mine.id, note: 'vượt trần' })
    expect(full.isError).toBe(true)
    expect(full.content[0].text).toContain('50')
    expect(await count('ai_action_drafts WHERE user_id = $1', [u.id])).toBe(50)
    const tv = await connect(v.token, 'crm.read crm.write')
    const theirs = await mkContact('Của v', { assigned_to: v.id })
    await propose(tv.access, 'add_contact_note', { contact_id: theirs.id, note: 'ok' })
  })

  it('mỗi ỨNG DỤNG tối đa 20 đề xuất chờ: một client bị prompt-injection không chiếm hết hạn mức của người dùng (client khác vẫn tạo được)', async () => {
    const u = await makeUser({ ...WRITER })
    const bad = await connect(u.token, 'crm.read crm.write')
    const good = await connect(u.token, 'crm.read crm.write')
    const mine = await mkContact('Client cap', { assigned_to: u.id })
    for (let i = 0; i < 20; i += 1) {
      await q(`INSERT INTO ai_action_drafts (user_id, client_id, tool, params, summary, expires_at) VALUES ($1, $2, 'add_contact_note', $3::jsonb, 'x', now() + interval '1 hour')`, [u.id, bad.clientId, JSON.stringify({ contact_id: mine.id, note: `inj ${i}` })])
    }
    const r = await callTool(bad.access, 'add_contact_note', { contact_id: mine.id, note: 'thêm nữa' })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('Ứng dụng này')
    await propose(good.access, 'add_contact_note', { contact_id: mine.id, note: 'client khác vẫn được' })
  })

  it('tiến trình chết giữa chừng: approved chưa có kết quả ⇒ "executing" rồi "failed" (kết quả không rõ), job ghi nhận; AI KHÔNG được báo "approved"', async () => {
    const u = await makeUser({ ...WRITER })
    const t = await connect(u.token, 'crm.read crm.write')
    const mine = await mkContact('Kẹt', { assigned_to: u.id })
    const id = await propose(t.access, 'add_contact_note', { contact_id: mine.id, note: 'kẹt' })
    await q(`UPDATE ai_action_drafts SET status = 'approved', decided_at = now() WHERE id = $1`, [id])
    expect(ok<{ status: string }>(await getAction(u.token, id)).status).toBe('executing')
    expect((await callTool(t.access, 'get_action_status', { id })).structuredContent.data.status).toBe('executing')
    expect((await approve(u.token, id)).status).toBe(409)
    await q(`UPDATE ai_action_drafts SET decided_at = now() - interval '10 minutes' WHERE id = $1`, [id])
    const v = ok<{ status: string; error: string }>(await getAction(u.token, id))
    expect(v.status).toBe('failed')
    expect(v.error).toContain('Không rõ kết quả')
    const job = await control.runJob('ai-action-expiry')
    expect((job.body as { result: unknown }).result).toMatchObject({ stale: 1 })
    expect((await draftStatus(id)).status).toBe('failed')
  })

  it('tên khách chỉ vào summary khi khách nằm trong phạm vi ĐỌC (contacts.view) — update rộng hơn view không làm lộ tên cho AI', async () => {
    const other = await makeUser({ 'contacts.view': 'own' })
    const u = await makeUser({ ...WRITER, 'contacts.view': 'own', 'contacts.update': 'all' })
    const t = await connect(u.token, 'crm.read crm.write')
    const theirs = await mkContact('Chỉ update thấy', { assigned_to: other.id })
    const r = await callTool(t.access, 'add_contact_note', { contact_id: theirs.id, note: 'x' })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r)).not.toContain('Chỉ update thấy')
    expect(await count('ai_action_drafts')).toBe(0)
  })

  it('get_action_status: chỉ thấy nháp do CHÍNH kết nối này tạo (kết nối khác của cùng người ⇒ không thấy)', async () => {
    const u = await makeUser({ ...WRITER })
    const t1 = await connect(u.token, 'crm.read crm.write')
    const t2 = await connect(u.token, 'crm.read crm.write')
    const mine = await mkContact('Kết nối', { assigned_to: u.id })
    const id = await propose(t1.access, 'add_contact_note', { contact_id: mine.id, note: 'riêng' })
    expect((await callTool(t1.access, 'get_action_status', { id })).isError).toBeUndefined()
    expect((await callTool(t2.access, 'get_action_status', { id })).isError).toBe(true)
  })

  it('đã đưa vào tools/list: đủ tool đề xuất với annotations đúng; KHÔNG có tool xoá/xuất/quản trị', async () => {
    const u = await makeUser({ ...WRITER })
    const t = await connect(u.token, 'crm.read crm.write')
    const tools = (await rpc(t.access, 'tools/list')).body.result.tools as { name: string; annotations: Record<string, boolean> }[]
    const names = tools.map((x) => x.name)
    expect(names).toEqual(expect.arrayContaining(['create_contact', 'add_contact_note', 'update_contact_stage', 'create_task', 'assign_contact', 'get_action_status', 'list_crm_options']))
    expect(names.filter((n) => /delete|remove|export|download|role|user_|password|approve/i.test(n))).toEqual([])
    const writes = tools.filter((x) => ['create_contact', 'add_contact_note', 'update_contact_stage', 'create_task', 'assign_contact'].includes(x.name))
    expect(writes.every((x) => x.annotations.readOnlyHint === false)).toBe(true)
    const byName = Object.fromEntries(tools.map((x) => [x.name, x.annotations]))
    expect(byName.create_contact.destructiveHint).toBe(false)
    expect(byName.update_contact_stage.destructiveHint).toBe(true)
    expect(byName.assign_contact.destructiveHint).toBe(true)
    expect(byName.list_contacts.readOnlyHint).toBe(true)
  })

  it('list_crm_options: id hợp lệ theo quyền; người nhận chỉ trong scope contacts.transfer', async () => {
    const u = await makeUser({ ...WRITER })
    const sub = await makeUser({ 'contacts.view': 'own' }, { managerId: u.id })
    const stranger = await makeUser({ 'contacts.view': 'own' })
    const t = await connect(u.token, 'crm.read crm.write')
    const d = (await callTool(t.access, 'list_crm_options')).structuredContent.data as Record<string, { id: number }[]>
    expect(d.sources.map((x) => x.id)).toContain(sourceId)
    expect(d.stages.map((x) => x.id)).toEqual(expect.arrayContaining([stageA, stageB]))
    const ids = d.assignable_users.map((x) => x.id)
    expect(ids).toContain(sub.id)
    expect(ids).not.toContain(stranger.id)
  })
})

describe('đồng ý OAuth', () => {
  it('màn đồng ý: crm.write khả dụng + tuỳ chọn; granted_scopes ⊆ scope đã hiển thị; thiếu crm.read ⇒ 400', async () => {
    const u = await makeUser({ ...WRITER })
    const reg = await httpCall('POST', '/api/v1/oauth/register', { body: { client_name: 'X', redirect_uris: [REDIRECT] }, ip: freshIp() })
    const params = {
      response_type: 'code', client_id: (reg.body as { client_id: string }).client_id, redirect_uri: REDIRECT, scope: 'crm.read crm.write', state: 's', resource: MCP,
      code_challenge: createHash('sha256').update('v'.repeat(50)).digest('base64url'), code_challenge_method: 'S256',
    }
    const ctx = await httpCall('POST', '/api/v1/oauth/authorize/context', { token: u.token, body: { params }, ip: freshIp() })
    expect(ctx.status).toBe(200)
    const cb = ctx.body as { scopes: unknown[]; consent_token: string }
    expect(cb.scopes).toEqual([
      expect.objectContaining({ scope: 'crm.read', available: true, optional: false }),
      expect.objectContaining({ scope: 'crm.write', available: true, optional: true }),
    ])
    const decide = (granted?: unknown) =>
      httpCall('POST', '/api/v1/oauth/authorize/decision', { token: u.token, body: { params, approve: true, consent_token: cb.consent_token, ...(granted !== undefined ? { granted_scopes: granted } : {}) }, ip: freshIp() })
    expect((await decide(['crm.write'])).status).toBe(400) // thiếu crm.read
    expect((await decide(['crm.read', 'offline_access'])).status).toBe(400) // ngoài tập đã hiển thị
    expect((await decide([])).status).toBe(400)
    expect((await decide('crm.read')).status).toBe(400)
    expect((await decide(['crm.read'])).status).toBe(200)
    expect((await q<{ scopes: string[] }>(`SELECT scopes FROM oauth_authorization_codes LIMIT 1`))[0].scopes).toEqual(['crm.read'])
  })
})

describe('ghi thẳng (cài đặt duyệt TẮT — mặc định)', () => {
  beforeEach(async () => {
    await setApproval(false)
  })

  it('create_contact chạy NGAY: khách + outbox contact.created + audit ai_action.execute; không thông báo chờ duyệt; lịch sử executed; SĐT đầy đủ không lộ', async () => {
    const u = await makeUser({ ...WRITER })
    const t = await connect(u.token, 'crm.read crm.write')
    const r = await callTool(t.access, 'create_contact', { full_name: `${P} Trần Thị Thẳng`, phone: FULL_PHONE, source_id: sourceId, stage_id: stageA })
    expect(r.isError).toBeUndefined()
    const d = r.structuredContent.data
    expect(d).toMatchObject({ status: 'executed' })
    const contactId = d.result.contact_id as number
    expect(JSON.stringify(r)).not.toContain(FULL_PHONE)
    expect((await q<Record<string, unknown>>(`SELECT * FROM contacts WHERE id = $1`, [contactId]))[0]).toMatchObject({ full_name: `${P} Trần Thị Thẳng`, phone: FULL_PHONE, assigned_to: u.id, source_id: sourceId })
    const ev = await q<{ actor_user_id: number }>(`SELECT actor_user_id FROM integration_events WHERE event_type = 'contact.created'`)
    expect(ev).toHaveLength(1)
    expect(ev[0].actor_user_id).toBe(u.id)
    expect(await count(`integration_audit_logs WHERE action = 'ai_action.execute' AND status = 'ok'`)).toBe(1)
    expect(await count(`notification_logs WHERE recipient_id = $1 AND event_type = 'ai_action.created'`, [u.id])).toBe(0)
    const row = (await q<{ status: string; tool: string; result: unknown }>(`SELECT status, tool, result FROM ai_action_drafts WHERE id = $1`, [d.action_id]))[0]
    expect(row).toMatchObject({ status: 'executed', tool: 'create_contact' })
    expect(row.result).toMatchObject({ contact_id: contactId })
    const list = ok<{ data: Record<string, unknown>[] }>(await api.get(ACTIONS, { token: u.token, ip: freshIp() }))
    expect(list.data[0]).toMatchObject({ tool: 'create_contact', status: 'executed', client_name: 'ChatGPT e2e' })
    expect(JSON.stringify(list)).not.toContain(FULL_PHONE)
    expect(ok(await api.get(`${ACTIONS}/pending-count`, { token: u.token, ip: freshIp() }))).toEqual({ pending: 0 })
    expect((await callTool(t.access, 'get_action_status', { id: d.action_id })).structuredContent.data.status).toBe('executed')
  })

  it('add_contact_note / update_contact_stage / create_task chạy ngay theo quyền (activity, outbox, thẻ giao cho chính người dùng)', async () => {
    const u = await makeUser({ ...WRITER })
    const t = await connect(u.token, 'crm.read crm.write')
    const mine = await mkContact('Của tôi thẳng', { assigned_to: u.id })
    const [board] = await q<{ id: number }>(`INSERT INTO kanban_boards (name) VALUES ($1) RETURNING id`, [`${P} bảng thẳng`])
    const [col] = await q<{ id: number }>(`INSERT INTO kanban_columns (board_id, name, position) VALUES ($1, 'Mới', 1) RETURNING id`, [board.id])
    const n = await callTool(t.access, 'add_contact_note', { contact_id: mine.id, note: 'Ghi thẳng' })
    const s = await callTool(t.access, 'update_contact_stage', { contact_id: mine.id, stage_id: stageB })
    const k = await callTool(t.access, 'create_task', { title: 'Việc ghi thẳng', column_id: col.id, contact_id: mine.id })
    for (const r of [n, s, k]) expect({ err: r.isError, st: r.structuredContent?.data.status }).toEqual({ err: undefined, st: 'executed' })
    expect((await q<{ stage_id: number }>(`SELECT stage_id FROM contacts WHERE id = $1`, [mine.id]))[0].stage_id).toBe(stageB)
    expect(await count('activities WHERE contact_id = $1', [mine.id])).toBeGreaterThanOrEqual(1)
    expect((await q<{ title: string }>(`SELECT title FROM kanban_cards WHERE id = $1`, [k.structuredContent.data.result.card_id]))[0].title).toBe('Việc ghi thẳng')
  })

  it('thiếu quyền ⇒ lỗi và KHÔNG ghi gì; ngoài phạm vi ⇒ lỗi và KHÔNG ghi gì; token chỉ crm.read ⇒ insufficient_scope', async () => {
    const noCreate = await makeUser({ 'integrations.ai_connect': true, 'contacts.view': 'own' })
    const t1 = await connect(noCreate.token, 'crm.read crm.write')
    const r = await callTool(t1.access, 'create_contact', { full_name: `${P} Không quyền thẳng`, phone: FULL_PHONE, source_id: sourceId })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('contacts.create')

    const other = await makeUser({ 'contacts.view': 'own' })
    const u = await makeUser({ ...WRITER })
    const t2 = await connect(u.token, 'crm.read crm.write')
    const theirs = await mkContact('Người khác thẳng', { assigned_to: other.id })
    const before = await count('activities WHERE contact_id = $1', [theirs.id])
    expect((await callTool(t2.access, 'add_contact_note', { contact_id: theirs.id, note: 'Lấn quyền' })).isError).toBe(true)
    expect((await callTool(t2.access, 'update_contact_stage', { contact_id: theirs.id, stage_id: stageB })).isError).toBe(true)
    expect(await count('activities WHERE contact_id = $1', [theirs.id])).toBe(before)
    expect((await q<{ stage_id: number }>(`SELECT stage_id FROM contacts WHERE id = $1`, [theirs.id]))[0].stage_id).toBe(stageA)

    const t3 = await connect(u.token, 'crm.read crm.write', { granted: ['crm.read'] })
    const r4 = await callTool(t3.access, 'create_contact', { full_name: `${P} Chỉ đọc thẳng`, phone: FULL_PHONE, source_id: sourceId })
    expect(r4.isError).toBe(true)
    expect(r4.content[0].text).toContain('insufficient_scope')
    expect(await count(`contacts WHERE full_name IN ('Không quyền thẳng', 'Chỉ đọc thẳng')`)).toBe(0)
    expect(await count(`ai_action_drafts WHERE status = 'executed'`)).toBe(0)
  })

  it('quyền bị gỡ sau khi kết nối ⇒ lần ghi kế tiếp bị từ chối (quyền kiểm lại mỗi lần gọi)', async () => {
    const u = await makeUser({ ...WRITER })
    const t = await connect(u.token, 'crm.read crm.write')
    expect((await callTool(t.access, 'create_contact', { full_name: `${P} Trước khi gỡ`, phone: '0987654322', source_id: sourceId })).isError).toBeUndefined()
    await q(`DELETE FROM role_permissions WHERE role_id IN (SELECT role_id FROM user_roles WHERE user_id = $1) AND permission = 'contacts.create'`, [u.id])
    expect((await control.flushCache()).status).toBe(200)
    const r = await callTool(t.access, 'create_contact', { full_name: `${P} Sau khi gỡ`, phone: '0987654323', source_id: sourceId })
    expect(r.isError).toBe(true)
    expect(await count(`contacts WHERE full_name = '${P} Sau khi gỡ'`)).toBe(0)
  })

  it('cài đặt: mọi người đọc được, chỉ ai_admin ghi; bật ⇒ AI quay về nháp chờ duyệt (pending, không ghi), tắt ⇒ ghi thẳng lại', async () => {
    const u = await makeUser({ ...WRITER })
    const admin = await makeUser({ 'integrations.ai_admin': true })
    const t = await connect(u.token, 'crm.read crm.write')
    expect(ok(await api.get(`${ACTIONS}/settings`, { token: u.token, ip: freshIp() }))).toEqual({ require_approval: false })
    expect((await api.patch(`${ACTIONS}/settings`, { token: u.token, body: { require_approval: true }, ip: freshIp() })).status).toBe(403)
    expect((await api.patch(`${ACTIONS}/settings`, { token: admin.token, body: { require_approval: 'yes' }, ip: freshIp() })).status).toBe(400)
    expect(ok(await api.patch(`${ACTIONS}/settings`, { token: admin.token, body: { require_approval: true }, ip: freshIp() }))).toEqual({ require_approval: true })
    const pending = await callTool(t.access, 'create_contact', { full_name: `${P} Chờ duyệt thẳng`, phone: FULL_PHONE, source_id: sourceId })
    expect(pending.structuredContent.data.status).toBe('pending')
    expect(await count(`contacts WHERE full_name = '${P} Chờ duyệt thẳng'`)).toBe(0)
    expect((await api.patch(`${ACTIONS}/settings`, { token: admin.token, body: { require_approval: false }, ip: freshIp() })).status).toBe(200)
    const direct = await callTool(t.access, 'create_contact', { full_name: `${P} Ghi thẳng lại`, phone: '0987654324', source_id: sourceId })
    expect(direct.structuredContent.data.status).toBe('executed')
  })

  it('trần ghi: 31 lần ghi/phút của một user ⇒ lần vượt bị chặn (lời gọi/phút hoặc trần ghi), dữ liệu không bị ghi thêm', async () => {
    const u = await makeUser({ ...WRITER })
    const t = await connect(u.token, 'crm.read crm.write')
    let okN = 0
    let blocked = 0
    for (let i = 0; i < 31; i += 1) {
      const r = await callTool(t.access, 'add_contact_note', { contact_id: (await mkContact(`Trần ${i}`, { assigned_to: u.id })).id, note: `n${i}` })
      if (r.isError) blocked += 1
      else okN += 1
    }
    expect(okN).toBeLessThanOrEqual(20) // trần mỗi ứng dụng AI
    expect(blocked).toBeGreaterThanOrEqual(11)
  })
})
