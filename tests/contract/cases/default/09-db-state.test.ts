import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, q, seedUser } from '../../lib/db.js'
import { dbGolden, dump, mark, type TableSpec } from '../../lib/dbdump.js'
import { api, control, freshIp } from '../../lib/http.js'
import { loginSeeded } from '../../lib/session.js'

afterAll(closeDb)

/**
 * C16 — so trạng thái DB sau kịch bản ghi. Mỗi kịch bản chạy một chuỗi lời gọi ghi qua HTTP, rồi dump các bảng bị đụng tới
 * (chỉ dòng mới, đã chuẩn hoá). Hai lượt trên cùng mã phải ra dump giống hệt; sau này so Node với Rust (DB-DUMP.md).
 */
const TABLES: TableSpec[] = [
  { table: 'contacts' },
  { table: 'deals' },
  { table: 'activities' },
  { table: 'audit_logs' },
  { table: 'integration_events' },
  { table: 'kanban_cards' },
  { table: 'newsfeed_posts' },
]

describe('trạng thái DB sau kịch bản ghi', () => {
  let token = ''
  let userId = 0
  let sourceId = 0
  beforeAll(async () => {
    const u = await seedUser({
      label: 'dbstate',
      grants: { 'contacts.view': 'all', 'contacts.create': null, 'contacts.update': 'all', 'contacts.delete': 'all', 'deals.view': 'all', 'deals.manage': 'all', 'kanban.view': 'all', 'kanban.manage': 'all', 'newsfeed.post': null },
    })
    userId = u.id
    sourceId = (await q<{ id: number }>(`SELECT id FROM setting_options WHERE group_key = 'contact_source' ORDER BY sort_order, id LIMIT 1`))[0].id
    token = (await loginSeeded(u)).token
  })
  const call = (m: 'post' | 'patch' | 'del', p: string, body?: unknown) => api[m](p, { token, body, ip: freshIp() })

  it('khách hàng: tạo, sửa, xoá mềm, khôi phục', async () => {
    const before = await mark(TABLES)
    const created = await call('post', '/contacts', { phone: '0933000111', full_name: 'DB State Một', source_id: sourceId })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const id = (created.body as { contact: { id: number } }).contact.id
    expect(id, JSON.stringify(created.body)).toBeTypeOf('number')
    const up = await call('patch', `/contacts/${id}`, { full_name: 'DB State Hai', zalo_account: 'dbstate.zalo' })
    expect(up.status, JSON.stringify(up.body)).toBe(200)
    expect((await call('del', `/contacts/${id}`)).status).toBeLessThan(300)
    expect((await call('post', `/contacts/${id}/restore`)).status).toBeLessThan(300)
    await control.flushCache()
    dbGolden('contact-lifecycle', await dump(TABLES, before))
  })

  it('deal: tạo, đổi trạng thái thắng', async () => {
    const before = await mark(TABLES)
    const c = await call('post', '/contacts', { phone: '0933000222', full_name: 'DB State Deal', source_id: sourceId })
    const contactId = (c.body as { contact: { id: number } }).contact.id
    const d = await call('post', '/deals', { title: 'Thương vụ DB state', contact_id: contactId, value: 1500000, assigned_to: userId })
    expect(d.status, JSON.stringify(d.body)).toBe(201)
    const id = (d.body as { id: number }).id
    expect((await call('patch', `/deals/${id}`, { status: 'won' })).status, 'won').toBe(200)
    dbGolden('deal-won', await dump(TABLES, before))
  })

  it('kanban và bảng tin: thẻ tạo, di chuyển; bài đăng', async () => {
    const before = await mark(TABLES)
    const boards = await api.get('/kanban/boards', { token, ip: freshIp() })
    const first = (boards.body as { id: number }[])[0]
    const board = (await api.get(`/kanban/boards/${first.id}`, { token, ip: freshIp() })).body as { columns: { id: number; is_archived: boolean }[] }
    const cols = board.columns.filter((c) => !c.is_archived)
    const card = await call('post', '/kanban/cards', { column_id: cols[0].id, title: 'Thẻ DB state' })
    expect(card.status, JSON.stringify(card.body)).toBe(201)
    const cardId = (card.body as { id: number }).id
    const mv = await call('post', `/kanban/cards/${cardId}/move`, { column_id: cols[1].id })
    expect(mv.status, JSON.stringify(mv.body)).toBeLessThan(300)
    expect((await call('post', '/newsfeed', { category: 'training', content: 'Bài DB state' })).status).toBeLessThan(300)
    dbGolden('kanban-newsfeed', await dump(TABLES, before))
  })
})
