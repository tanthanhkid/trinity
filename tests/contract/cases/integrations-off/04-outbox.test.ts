import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { closeDb, q, seedContact } from '../../lib/db.js'
import { api, call, freshIp } from '../../lib/http.js'
import { a, mk, st, type Body } from '../../lib/webhooks.js'

afterAll(closeDb)
const PHONES = ['0900001201', '0900001302', '0900001403']
let srcId = 0
let stageA = 0
let stageB = 0

beforeAll(async () => {
  const opt = async (group: string, value: string): Promise<number> =>
    (await q<{ id: number }>(`INSERT INTO setting_options (group_key, value, label, updated_at) VALUES ($1, $2, $2, now()) ON CONFLICT (group_key, value) DO UPDATE SET is_active = true RETURNING id`, [group, value]))[0].id
  srcId = await opt('contact_source', 'e2e_int_src')
  stageA = await opt('contact_stage', 'e2e_int_a')
  stageB = await opt('contact_stage', 'e2e_int_b')
})
beforeEach(async () => {
  await q(`TRUNCATE TABLE integration_events, integration_audit_logs RESTART IDENTITY`)
  await q(`DELETE FROM deals WHERE title LIKE 'E2E int deal%'`)
  await q(`DELETE FROM deals WHERE contact_id IN (SELECT id FROM contacts WHERE phone = ANY($1))`, [PHONES])
  await q(`DELETE FROM api_keys WHERE name = 'e2e-int-key'`)
  await q(`DELETE FROM activities WHERE contact_id IN (SELECT id FROM contacts WHERE phone = ANY($1))`, [PHONES])
  await q(`DELETE FROM contacts WHERE phone = ANY($1)`, [PHONES])
})

interface Ev { event_type: string; resource: string; resource_id: string; actor_user_id: number | null; dispatched_at: string | null; payload: Body }
const events = (type?: string): Promise<Ev[]> => q<Ev>(`SELECT * FROM integration_events ${type ? `WHERE event_type = '${type}'` : ''} ORDER BY id`)
const names = async (): Promise<string[]> => (await events()).map((e) => e.event_type)

/**
 * C12b, hồ sơ `integrations-off`: nhóm "outbox" của `integrations.e2e-spec.ts` (11 ca, cờ TẮT như e2e gốc): mọi đường ghi khách/deal để lại dòng
 * `integration_events` bất kể cờ. Ca ROLLBACK gọi `publishIntegrationEvent` trong transaction Prisma (không có ở hộp đen) đổi thành đường HTTP:
 * ghi bị từ chối (409 trùng SĐT) không để lại dòng outbox; ghi thành công để lại đúng một dòng.
 */
describe('outbox: mọi đường ghi để lại integration_events (cờ TẮT)', () => {
  it('POST /contacts → contact.created (actor = người tạo, SĐT thô trong payload)', async () => {
    const u = await mk({ 'contacts.create': true })
    const res = await st(a(u.token).post('/contacts', { phone: PHONES[0], full_name: 'Khách outbox', source_id: srcId, stage_id: stageA }), 201)
    const id = (res.body as Body).contact.id
    const evs = await events()
    expect(evs.map((e) => e.event_type)).toEqual(['contact.created'])
    expect(evs[0]).toMatchObject({ resource: 'contact', resource_id: String(id), actor_user_id: u.id, dispatched_at: null })
    expect(evs[0].payload.contact).toMatchObject({ id, phone: PHONES[0], stage_id: stageA })
    expect(evs[0].payload.origin).toBe('manual')
  })

  it('POST /contacts kèm deal_assigned_to → contact.created + deal.created', async () => {
    const sale = await mk({})
    const u = await mk({ 'contacts.create': true, 'deals.manage': 'all' })
    await st(a(u.token).post('/contacts', { phone: PHONES[0], full_name: 'Khách + deal', source_id: srcId, deal_assigned_to: sale.id }), 201)
    expect((await names()).sort()).toEqual(['contact.created', 'deal.created'])
  })

  it('PATCH /contacts/:id đổi giai đoạn → contact.updated + contact.stage_changed (from/to); sửa tên thì chỉ contact.updated', async () => {
    const u = await mk({ 'contacts.update': 'all' })
    const c = await seedContact({ phone: PHONES[0], name: 'A', ownerId: u.id })
    await q(`UPDATE contacts SET full_name = NULL, stage_id = $2 WHERE id = $1`, [c, stageA])
    await st(a(u.token).patch(`/contacts/${c}`, { stage_id: stageB }), 200)
    let evs = await events()
    expect(evs.map((e) => e.event_type).sort()).toEqual(['contact.stage_changed', 'contact.updated'])
    expect(evs.find((e) => e.event_type === 'contact.stage_changed')?.payload).toMatchObject({ from_stage_id: stageA, to_stage_id: stageB })
    expect(evs.find((e) => e.event_type === 'contact.updated')?.payload.changed_fields).toEqual(['stage_id'])
    await q(`DELETE FROM integration_events`)
    await st(a(u.token).patch(`/contacts/${c}`, { full_name: 'Tên mới' }), 200)
    evs = await events()
    expect(evs.map((e) => e.event_type)).toEqual(['contact.updated'])
    expect(evs[0].payload.changed_fields).toEqual(['full_name'])
  })

  it('PATCH không đổi gì thật (thân rỗng) → KHÔNG có sự kiện', async () => {
    const u = await mk({ 'contacts.update': 'all' })
    const c = await seedContact({ phone: PHONES[0], name: 'A', ownerId: u.id })
    await st(a(u.token).patch(`/contacts/${c}`, {}), 200)
    expect(await events()).toHaveLength(0)
  })

  it('POST /contacts/:id/transfer → contact.assigned (from/to + lý do); chuyển bị từ chối → không có sự kiện', async () => {
    const boss = await mk({ 'contacts.transfer': 'all' })
    const from = await mk({})
    const to = await mk({})
    const c = await seedContact({ phone: PHONES[0], name: 'A', ownerId: from.id })
    await st(a(boss.token).post(`/contacts/${c}/transfer`, { new_assigned_to: 99999999 }), 400)
    expect(await events()).toHaveLength(0)
    await st(a(boss.token).post(`/contacts/${c}/transfer`, { new_assigned_to: to.id, reason: 'nghỉ việc' }), 201)
    const evs = await events('contact.assigned')
    expect(evs).toHaveLength(1)
    expect(evs[0].actor_user_id).toBe(boss.id)
    expect(evs[0].payload).toMatchObject({ from_user_id: from.id, to_user_id: to.id, reason: 'nghỉ việc', contact: { id: c, assigned_to: to.id } })
  })

  it('DELETE /contacts/:id (xoá mềm) → contact.deleted có deleted_at', async () => {
    const u = await mk({ 'contacts.delete': 'all' })
    const c = await seedContact({ phone: PHONES[0], name: 'A', ownerId: u.id })
    await st(a(u.token).del(`/contacts/${c}`), 200)
    const evs = await events('contact.deleted')
    expect(evs).toHaveLength(1)
    expect(evs[0].payload.contact).toMatchObject({ id: c })
    expect(evs[0].payload.contact.deleted_at).not.toBeNull()
  })

  it('POST /public/contacts (khoá API) → contact.created origin public_api, response không lộ trường snapshot', async () => {
    const owner = await mk({})
    const raw = `e2e-int-key-${Date.now()}`
    await q(`INSERT INTO api_keys (name, prefix, key_hash, scopes, owner_user_id, created_by, updated_at) VALUES ('e2e-int-key', $1, $2, ARRAY['contacts:create'], $3, $3, now())`, [raw.slice(0, 24), createHash('sha256').update(raw).digest('hex'), owner.id])
    const res = await call('POST', '/api/v1/public/contacts', { headers: { 'x-api-key': raw }, body: { phone: PHONES[1], full_name: 'Khách API', source_id: srcId }, ip: freshIp() })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const contact = (res.body as Body).contact
    expect(Object.keys(contact).sort()).toEqual(['assigned_to', 'created_at', 'full_name', 'id', 'phone', 'source_id'])
    const evs = await events('contact.created')
    expect(evs).toHaveLength(1)
    expect(evs[0].payload).toMatchObject({ origin: 'public_api', contact: { id: contact.id, assigned_to: owner.id } })
  })

  it('Deal: tạo → deal.created; đổi status won → stage_changed + won; lost → stage_changed + lost; sửa tên → không sự kiện', async () => {
    const u = await mk({ 'deals.manage': 'all' })
    const created = await st(a(u.token).post('/deals', { title: 'E2E int deal 1', assigned_to: u.id, value: 5_000_000 }), 201)
    const id = (created.body as Body).id
    expect(await names()).toEqual(['deal.created'])
    expect((await events())[0].payload).toMatchObject({ deal: { id, value: '5000000', status: 'open' } })

    await q(`DELETE FROM integration_events`)
    await st(a(u.token).patch(`/deals/${id}`, { title: 'E2E int deal 1b' }), 200)
    expect(await events()).toHaveLength(0)

    await st(a(u.token).patch(`/deals/${id}`, { status: 'won' }), 200)
    let evs = await events()
    expect(evs.map((e) => e.event_type)).toEqual(['deal.stage_changed', 'deal.won'])
    expect(evs[0].payload).toMatchObject({ from_status: 'open', to_status: 'won' })

    await q(`DELETE FROM integration_events`)
    await st(a(u.token).patch(`/deals/${id}`, { status: 'lost' }), 200)
    evs = await events()
    expect(evs.map((e) => e.event_type)).toEqual(['deal.stage_changed', 'deal.lost'])
    expect(evs[0].payload).toMatchObject({ from_status: 'won', to_status: 'lost' })
  })

  it('Deal tạo thẳng ở trạng thái won → deal.created + deal.won', async () => {
    const u = await mk({ 'deals.manage': 'all' })
    await st(a(u.token).post('/deals', { title: 'E2E int deal 2', assigned_to: u.id, status: 'won' }), 201)
    expect(await names()).toEqual(['deal.created', 'deal.won'])
  })

  it('ROLLBACK (qua HTTP): ghi bị từ chối (trùng SĐT → 409) không để lại dòng outbox; ghi thành công để lại đúng 1 dòng', async () => {
    const u = await mk({ 'contacts.create': true })
    const body = { phone: PHONES[2], full_name: 'Khách rollback', source_id: srcId }
    await st(a(u.token).post('/contacts', body), 201)
    expect(await events()).toHaveLength(1)
    await st(a(u.token).post('/contacts', { ...body, full_name: 'Khách trùng' }), 409)
    expect(await events()).toHaveLength(1)
  })

  it('cờ TẮT ⇒ route nhật ký 404 nhưng outbox vẫn ghi (chỉ thêm insert, không đổi hành vi nghiệp vụ)', async () => {
    const u = await mk({ 'contacts.create': true, 'integrations.ai_admin': true })
    await st(a(u.token).post('/contacts', { phone: PHONES[2], full_name: 'Khách cờ tắt', source_id: srcId }), 201)
    await st(a(u.token).get('/integrations/audit-logs'), 404)
    expect(await events('contact.created')).toHaveLength(1)
    void api
  })
})
