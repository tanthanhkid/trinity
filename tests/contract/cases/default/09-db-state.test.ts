import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, q, seedUser } from '../../lib/db.js'
import { dbGolden, dump, mark, type TableSpec } from '../../lib/dbdump.js'
import { api, control, freshIp, type Res } from '../../lib/http.js'
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
  { table: 'attendance_records' },
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

  /** Kiểm mã trạng thái TRƯỚC khi đọc body (body lỗi không có trường mong đợi). */
  const ok = <T>(res: Res, status: number | number[], what: string): T => {
    expect([status].flat(), `${what}: ${res.status} ${JSON.stringify(res.body)}`).toContain(res.status)
    return res.body as T
  }

  it('khách hàng: tạo, sửa, xoá mềm, khôi phục', async () => {
    const before = await mark(TABLES)
    const { contact } = ok<{ contact: { id: number } }>(await call('post', '/contacts', { phone: '0933000111', full_name: 'DB State Một', source_id: sourceId }), 201, 'tạo khách')
    ok(await call('patch', `/contacts/${contact.id}`, { full_name: 'DB State Hai', zalo_account: 'dbstate.zalo' }), 200, 'sửa khách')
    ok(await call('del', `/contacts/${contact.id}`), [200, 204], 'xoá khách')
    ok(await call('post', `/contacts/${contact.id}/restore`), [200, 201], 'khôi phục khách')
    await control.flushCache()
    dbGolden('contact-lifecycle', await dump(TABLES, before))
  })

  it('deal: tạo, đổi trạng thái thắng', async () => {
    const before = await mark(TABLES)
    const { contact } = ok<{ contact: { id: number } }>(await call('post', '/contacts', { phone: '0933000222', full_name: 'DB State Deal', source_id: sourceId }), 201, 'tạo khách')
    const deal = ok<{ id: number }>(await call('post', '/deals', { title: 'Thương vụ DB state', contact_id: contact.id, value: 1500000, assigned_to: userId }), 201, 'tạo deal')
    ok(await call('patch', `/deals/${deal.id}`, { status: 'won' }), 200, 'deal thắng')
    dbGolden('deal-won', await dump(TABLES, before))
  })

  it('kanban và bảng tin: thẻ tạo, di chuyển; bài đăng', async () => {
    const before = await mark(TABLES)
    const boards = ok<{ id: number }[]>(await api.get('/kanban/boards', { token, ip: freshIp() }), 200, 'danh sách board')
    expect(boards.length).toBeGreaterThan(0)
    const board = ok<{ columns: { id: number; is_archived: boolean }[] }>(await api.get(`/kanban/boards/${boards[0].id}`, { token, ip: freshIp() }), 200, 'board')
    const cols = board.columns.filter((c) => !c.is_archived)
    expect(cols.length, 'board mặc định cần ít nhất 2 cột để kiểm di chuyển').toBeGreaterThanOrEqual(2)
    const card = ok<{ id: number }>(await call('post', '/kanban/cards', { column_id: cols[0].id, title: 'Thẻ DB state' }), 201, 'tạo thẻ')
    ok(await call('post', `/kanban/cards/${card.id}/move`, { column_id: cols[1].id }), [200, 201], 'di chuyển thẻ')
    ok(await call('post', '/newsfeed', { category: 'training', content: 'Bài DB state' }), [200, 201], 'đăng bài')
    const [row] = await q<{ column_id: number }>(`SELECT column_id FROM kanban_cards WHERE id = $1`, [card.id])
    expect(row.column_id, 'thẻ phải nằm ở cột đích').toBe(cols[1].id)
    dbGolden('kanban-newsfeed', await dump(TABLES, before))
  })

  it('sửa dòng có sẵn vẫn vào dump; cột date ra nhãn ngày', async () => {
    const { contact } = ok<{ contact: { id: number } }>(await call('post', '/contacts', { phone: '0933000333', full_name: 'DB State Cũ', source_id: sourceId }), 201, 'tạo khách trước kịch bản')
    await new Promise((r) => setTimeout(r, 50))
    const before = await mark(TABLES)
    ok(await call('patch', `/contacts/${contact.id}`, { birthday: '1990-05-17' }), 200, 'đặt ngày sinh')
    const out = await dump(TABLES, before)
    const rows = out.contacts as { birthday: unknown; full_name: string }[]
    expect(rows, 'dòng cũ bị sửa phải có trong dump').toHaveLength(1)
    // Cột `date` thật (attendance_records.work_date, chèn bằng SQL vì chấm công cần thiết bị): phải ra nhãn ngày, không thành timestamp.
    await q(`INSERT INTO attendance_records (user_id, work_date, updated_at) VALUES ($1, now()::date - 1, now())`, [userId])
    const withDate = await dump(TABLES, before)
    expect((withDate.attendance_records as { work_date: string }[])[0].work_date).toBe('<vn-day:-1>')
    dbGolden('contact-modified-existing', withDate)
  })
})
