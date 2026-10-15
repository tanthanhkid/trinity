import { test as setup } from '@playwright/test'
import { Api } from '../helpers/api'
import { WRITE_ENABLED, WRITE_SKIP_REASON, prefix } from '../helpers/data'
import { record, startManifest } from '../helpers/manifest'
import { mkContact, mkRole, mkUser, optionId, recordRoleUnassign, throwawayPassword, userIds } from './lib'
import { takeSnapshot } from './snapshot'

/**
 * SEED — chạy ĐẦU TIÊN khi E2E_ALLOW_WRITE=1 (project `seed`; `cleanup` là teardown của nó nên LUÔN chạy
 * sau cùng, cả khi test đỏ). Tạo bộ dữ liệu thử `E2E-` qua API (không SQL), ghi manifest từng mục ngay khi tạo.
 * Bảng "loại × số lượng × mục đích" ở e2e/README.md.
 */
setup.skip(!WRITE_ENABLED, WRITE_SKIP_REASON)
setup.setTimeout(240_000)

setup('seed bộ dữ liệu thử E2E-', async () => {
  const admin = await Api.forRole('ADMIN')
  const ids = await userIds(admin)
  const snap = await takeSnapshot(admin)
  if (snap.e2e.length) console.warn(`[seed] CÒN ${snap.e2e.length} bản ghi E2E- từ lần trước (cleanup sẽ dọn): ${JSON.stringify(snap.e2e.slice(0, 5))}`)
  startManifest(snap.real)

  // ── Khách hàng: mỗi tài khoản tạo khách của CHÍNH MÌNH (owner = người tạo) → kiểm phạm vi own/team/subtree/all ──
  const sourceIds = [await optionId(admin, 'contact_source'), await optionId(admin, 'contact_source', 'referral')]
  const stageIds = [await optionId(admin, 'contact_stage', 'new'), await optionId(admin, 'contact_stage', 'follow_up_1'), await optionId(admin, 'contact_stage', 'follow_up_2'), await optionId(admin, 'contact_stage', 'follow_up_3')]
  const made: Record<string, { id: number; name: string }[]> = {}
  for (const role of ['SALE', 'LEAD', 'DEPT_HEAD', 'ADMIN'] as const) {
    const api = role === 'ADMIN' ? admin : await Api.forRole(role)
    made[role] = []
    for (let i = 0; i < 3; i++) {
      made[role].push(await mkContact(api, role, `khach-${role.toLowerCase()}-${i + 1}`, { source_id: sourceIds[i % 2], stage_id: stageIds[(i + (role === 'SALE' ? 0 : 1)) % 4] }))
    }
    if (role !== 'ADMIN') await api.dispose()
  }

  // ── Deal: mở / thắng / thua, giao cho các cấp khác nhau ──
  const deals: [string, number, 'open' | 'won' | 'lost'][] = [
    ['deal-mo', ids.SALE, 'open'], ['deal-thang', ids.LEAD, 'won'], ['deal-thua', ids.SALE, 'lost'], ['deal-mo-dept_head', ids.DEPT_HEAD, 'open'],
  ]
  for (const [tag, assignee, status] of deals) {
    const title = prefix(tag)
    const d = await admin.post<{ id: number }>('/deals', { title, assigned_to: assignee, value: 1_500_000, contact_id: made.SALE[0].id })
    record({ kind: 'deal', id: d.id, label: title, meta: { status, assignee }, del: `/deals/${d.id}` })
    if (status !== 'open') await admin.patch(`/deals/${d.id}`, { status })
  }

  // ── Kanban: bảng + 3 cột + 4 thẻ giao cho 4 người ──
  const boardName = prefix('bang')
  const board = await admin.post<{ id: number }>('/kanban/boards', { name: boardName })
  record({ kind: 'kanban-board', id: board.id, label: boardName, del: `/kanban/boards/${board.id}`, soft: { table: 'kanban_boards', note: 'xoá mềm; cột + thẻ của bảng cũng còn (kanban_columns, kanban_cards)' } })
  const cols: number[] = []
  for (const [name, isDone] of [['Mới', false], ['Đang làm', false], ['Xong', true]] as const) {
    const c = await admin.post<{ id: number }>(`/kanban/boards/${board.id}/columns`, { name: `E2E-${name}`, is_done: isDone })
    cols.push(c.id)
    record({ kind: 'kanban-column', id: c.id, label: `E2E-${name}`, soft: { table: 'kanban_columns', note: 'thuộc bảng E2E- đã xoá mềm' } })
  }
  for (const [tag, who] of [['the-sale', 'SALE'], ['the-lead', 'LEAD'], ['the-dept_head', 'DEPT_HEAD'], ['the-admin', 'ADMIN']] as const) {
    const title = prefix(tag)
    const c = await admin.post<{ id: number }>('/kanban/cards', { column_id: cols[0], title, assignee_id: ids[who] })
    record({ kind: 'kanban-card', id: c.id, label: title, meta: { assignee: who }, del: `/kanban/cards/${c.id}`, soft: { table: 'kanban_cards', note: 'xoá mềm (deleted_at)' } })
  }

  // ── Sản phẩm + dự án ──
  const code = `E2E-${Date.now()}`
  const prod = await admin.post<{ id: number }>('/products', { code, name: prefix('sanpham'), price: 99_000 })
  record({ kind: 'product', id: prod.id, label: code, del: `/products/${prod.id}` })
  const projName = prefix('duan')
  const proj = await admin.post<{ id: number }>('/projects', { name: projName, code: `e2e_${Date.now()}` })
  record({ kind: 'project', id: proj.id, label: projName, del: `/projects/${proj.id}`, soft: { table: 'projects', note: 'xoá mềm (is_active=false)' } })

  // ── Nhân sự: chức danh, nhân viên, hợp đồng, tuyển dụng ──
  const jtName = prefix('chucdanh')
  const jt = await admin.post<{ id: number }>('/management/job-titles', { category: 'E2E', rank_code: `E${String(Date.now()).slice(-9)}`, name: jtName, symbol: 'E2E', review_cycle_months: 6 })
  record({ kind: 'job-title', id: jt.id, label: jtName, del: `/management/job-titles/${jt.id}` })
  const empEmail = `e2e-${Date.now()}-nv@trinity.local`
  const empName = prefix('nhanvien')
  const emp = await admin.post<{ id: number; user_id: number }>('/management/employees', { email: empEmail, full_name: empName, password: throwawayPassword(empEmail), job_title_id: jt.id, position: 'E2E', joined_at: '2026-01-05' })
  record({ kind: 'user', id: emp.user_id, label: empEmail, del: `/users/${emp.user_id}/permanent`, soft: { table: 'users', note: 'tài khoản của nhân viên E2E- (xoá mềm)' } })
  record({ kind: 'employee', id: emp.id, label: empName, del: `/management/employees/${emp.id}`, soft: { table: 'employees', note: 'xoá mềm (deleted_at)' } })
  const ct = await admin.post<{ id: number }>('/management/contracts', { employee_id: emp.id, signed_date: '2026-01-05', contract_type: 'thu_viec', notes: prefix('hopdong') })
  record({ kind: 'contract', id: ct.id, label: `hợp đồng NV ${emp.id}`, del: `/management/contracts/${ct.id}` })
  const candName = prefix('ungvien')
  const cand = await admin.post<{ id: number }>('/management/recruitment/candidates', { full_name: candName, position: 'E2E', stage: 'applied' })
  record({ kind: 'candidate', id: cand.id, label: candName, del: `/management/recruitment/candidates/${cand.id}` })

  // ── Bảng tin: bài + bình luận (SALE) + reaction (LEAD) ──
  const post = await admin.post<{ id: number }>('/newsfeed', { category: 'training', content: prefix('baitin') })
  record({ kind: 'newsfeed', id: post.id, label: 'bài bảng tin', del: `/newsfeed/${post.id}` })
  const sale = await Api.forRole('SALE')
  await sale.post(`/newsfeed/${post.id}/comments`, { content: prefix('binhluan') })
  await sale.dispose()
  const lead = await Api.forRole('LEAD')
  await lead.post(`/newsfeed/${post.id}/like`)
  await lead.dispose()

  // ── Cài đặt: vai trò hẹp + user E2E; nguồn khách thử ──
  const role = await mkRole(admin, 'vaitro-hep', { 'contacts.view': 'own' })
  const user = await mkUser(admin, 'user-hep')
  await admin.put(`/users/${user.id}/roles`, { roleIds: [role.id] })
  recordRoleUnassign(user.id)
  record({ kind: 'narrow-user', id: user.id, label: user.email, meta: { email: user.email, role_id: role.id } })

  await admin.dispose()
})
