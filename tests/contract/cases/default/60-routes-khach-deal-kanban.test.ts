import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, q, seedContact, seedUser } from '../../lib/db.js'
import { call, freshIp, type Res } from '../../lib/http.js'
import { golden, snap } from '../../lib/golden.js'
import { threeRoleTokens } from '../../lib/roles.js'
import { loginAdmin, loginSeeded } from '../../lib/session.js'
import { clusterRoutes, coverage, keyOf, mark, type Kind, type RouteDef } from '../../lib/route-cover.js'

afterAll(closeDb)

/**
 * C14b: phủ đủ route cụm khách hàng, deal, kanban (56 route). Mỗi route có một công thức (`RECIPES`) dựng dữ liệu riêng rồi chạy các
 * loại ca mà `lib/route-cover.ts` đòi (suy từ `routes.json`): thiếu token 401, thiếu quyền 403, thành công đúng `status_ok`, id sai kiểu
 * 400, và các loại công thức khai (đầu vào sai 400, id không có, ngoài phạm vi 404). Route đọc dữ liệu khách ghi golden 3 vai và có ca
 * SĐT bị che với vai không có `contacts.phone_full`. Ca cuối kiểm độ phủ = 100%.
 */
const PREFIXES = ['/contacts', '/deals', '/kanban']
const routes = clusterRoutes(PREFIXES)

type Role = 'admin' | 'sale'
interface Call {
  path: string
  body?: unknown
  query?: Record<string, string>
  as?: Role
  /** Kiểm thêm trên response thành công. */
  check?: (res: Res) => void
}
interface Recipe {
  ok: () => Promise<Call>
  /** Đầu vào sai (thân hoặc query) ⇒ 400 (+ đoạn câu lỗi nếu có). */
  bad?: () => Promise<Call & { text?: string }>
  /** Id không tồn tại (thay mọi tham số `:xxx` bằng 999999) ⇒ mã này, bằng quyền Quản trị. */
  missing?: { status: number; body?: unknown }
  /** Ngoài phạm vi theo id: người `sale` (phạm vi own) gọi vào bản ghi của người khác ⇒ 404 (hoặc `outOfScopeStatus`). */
  outOfScope?: () => Promise<Call>
  outOfScopeStatus?: number
  /** Route đọc dữ liệu khách: ghi golden 3 vai và kiểm SĐT bị che với vai không có `contacts.phone_full`. */
  readsContacts?: () => Promise<Call>
  /** Route danh sách người dùng (không có SĐT): vẫn ghi golden 3 vai nhưng không đòi 200 (vai thiếu quyền nhận 403) và không có ca SĐT. */
  usersOnly?: boolean
}

// ---- Dữ liệu dùng chung --------------------------------------------------------------------------------------------
const tokens: Record<Role, string> = { admin: '', sale: '' }
let nobody = ''
let saleId = 0
let otherId = 0
let sourceId = 0
let phoneSeq = 0

const nextPhone = (): string => `0912${String(700000 + ++phoneSeq)}`

async function send(method: string, p: string, o: { token?: string; body?: unknown; query?: Record<string, string> } = {}): Promise<Res> {
  const qs = o.query ? `?${new URLSearchParams(o.query).toString()}` : ''
  // fetch không cho GET kèm thân.
  return call(method, `/api/v1${p}${qs}`, { token: o.token, body: method === 'GET' ? undefined : o.body, ip: freshIp() })
}

const ok = (res: Res, want: number): Res => {
  expect({ status: res.status, body: res.body }).toMatchObject({ status: want })
  return res
}

const idOf = (res: Res): number => {
  const b = res.body as { id?: number; data?: { id?: number } }
  const id = b.id ?? b.data?.id
  if (typeof id !== 'number') throw new Error(`không có id trong ${JSON.stringify(res.body).slice(0, 200)}`)
  return id
}

const mkContact = (owner = saleId): Promise<number> => seedContact({ phone: nextPhone(), name: 'Khách C14b', ownerId: owner })

async function mkDeal(owner = saleId, contactId?: number): Promise<number> {
  const [d] = await q<{ id: number }>(
    `INSERT INTO deals (title, assigned_to, created_by, contact_id, created_at, updated_at) VALUES ('Deal C14b', $1, $1, $2, now() - interval '1 day', now()) RETURNING id`,
    [owner, contactId ?? null],
  )
  return d.id
}

const admin = { token: () => tokens.admin }
async function post(p: string, body: unknown): Promise<Res> {
  return send('POST', p, { token: admin.token(), body })
}
const mkBoard = async (): Promise<number> => idOf(ok(await post('/kanban/boards', { name: 'Bảng C14b', visibility_role_ids: [] }), 201))
const mkColumn = async (board: number): Promise<number> => idOf(ok(await post(`/kanban/boards/${board}/columns`, { name: 'Cột C14b' }), 201))
const mkCard = async (col: number, title = 'Thẻ C14b'): Promise<number> => idOf(ok(await post('/kanban/cards', { column_id: col, title }), 201))
async function board2(): Promise<{ board: number; col: number; col2: number; card: number }> {
  const board = await mkBoard()
  const col = await mkColumn(board)
  const col2 = await mkColumn(board)
  return { board, col, col2, card: await mkCard(col) }
}
const mkItem = async (card: number): Promise<number> => idOf(ok(await post(`/kanban/cards/${card}/checklist-items`, { text: 'Việc nhỏ' }), 201))

/** Nhãn của board nằm trong `label_defs` của board (không có bảng riêng). */
async function mkLabel(board: number): Promise<string> {
  const res = ok(await post(`/kanban/boards/${board}/labels`, { name: 'Gấp', color: '#eb5a46' }), 201)
  return String((res.body as { labels: { id: string }[] }).labels.at(-1)?.id)
}

const BAD_ID = 'abc'
const MISSING = 999_999

// ---- Công thức theo route ------------------------------------------------------------------------------------------
const RECIPES: Record<string, Recipe> = {
  // Khách hàng
  'GET /contacts': {
    ok: async () => ({ path: '/contacts', query: { limit: '5' } }),
    bad: async () => ({ path: '/contacts', query: { limit: '0' } }),
    readsContacts: async () => {
      await mkContact()
      return { path: '/contacts', query: { limit: '50' } }
    },
  },
  'POST /contacts': {
    ok: async () => ({ path: '/contacts', body: { phone: nextPhone(), full_name: 'Khách tạo C14b', source_id: sourceId } }),
    bad: async () => ({ path: '/contacts', body: {} }),
  },
  'GET /contacts/:contactId/activities': {
    ok: async () => ({ path: `/contacts/${await mkContact()}/activities` }),
    missing: { status: 404 },
  },
  'DELETE /contacts/:id': {
    ok: async () => ({ path: `/contacts/${await mkContact()}` }),
    missing: { status: 404 },
    outOfScope: async () => ({ path: `/contacts/${await mkContact(otherId)}`, as: 'sale' }),
  },
  'GET /contacts/:id': {
    ok: async () => ({ path: `/contacts/${await mkContact()}` }),
    missing: { status: 404 },
    outOfScope: async () => ({ path: `/contacts/${await mkContact(otherId)}`, as: 'sale' }),
    readsContacts: async () => ({ path: `/contacts/${await mkContact()}` }),
  },
  'PATCH /contacts/:id': {
    ok: async () => ({ path: `/contacts/${await mkContact()}`, body: { full_name: 'Tên mới C14b' } }),
    bad: async () => ({ path: `/contacts/${await mkContact()}`, body: { full_name: 5 } }),
    missing: { status: 404, body: { full_name: 'x' } },
    outOfScope: async () => ({ path: `/contacts/${await mkContact(otherId)}`, body: { full_name: 'x' }, as: 'sale' }),
  },
  'POST /contacts/:id/restore': {
    ok: async () => {
      const id = await mkContact()
      ok(await send('DELETE', `/contacts/${id}`, { token: tokens.admin }), 200)
      return { path: `/contacts/${id}/restore` }
    },
    missing: { status: 404 },
  },
  'POST /contacts/:id/transfer': {
    ok: async () => ({ path: `/contacts/${await mkContact()}/transfer`, body: { new_assigned_to: otherId } }),
    bad: async () => ({ path: `/contacts/${await mkContact()}/transfer`, body: {} }),
    missing: { status: 404, body: { new_assigned_to: otherId } },
    outOfScope: async () => ({ path: `/contacts/${await mkContact(otherId)}/transfer`, body: { new_assigned_to: saleId }, as: 'sale' }),
    // Chuyển khách của người khác: Node từ chối 403 (quyền chuyển theo phạm vi), không che thành 404.
    outOfScopeStatus: 403,
  },
  'POST /contacts/:id/viewed': {
    ok: async () => ({ path: `/contacts/${await mkContact()}/viewed` }),
    missing: { status: 404 },
    outOfScope: async () => ({ path: `/contacts/${await mkContact(otherId)}/viewed`, as: 'sale' }),
  },
  'GET /contacts/assignable-sales': { ok: async () => ({ path: '/contacts/assignable-sales' }), readsContacts: async () => ({ path: '/contacts/assignable-sales' }), usersOnly: true },
  'GET /contacts/assignable-users': { ok: async () => ({ path: '/contacts/assignable-users' }), readsContacts: async () => ({ path: '/contacts/assignable-users' }), usersOnly: true },
  'POST /contacts/bulk-transfer': {
    ok: async () => ({ path: '/contacts/bulk-transfer', body: { contact_ids: [await mkContact()], new_assigned_to: otherId } }),
    bad: async () => ({ path: '/contacts/bulk-transfer', body: { contact_ids: [] } }),
  },
  'GET /contacts/export': {
    ok: async () => {
      await mkContact()
      return {
        path: '/contacts/export',
        check: (res) => expect(res.headers.get('content-type')).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
      }
    },
  },
  'GET /contacts/recent': {
    ok: async () => ({ path: '/contacts/recent' }),
    readsContacts: async () => {
      const id = await mkContact()
      ok(await send('POST', `/contacts/${id}/viewed`, { token: tokens.sale }), 201)
      return { path: '/contacts/recent' }
    },
  },
  'GET /contacts/search': {
    ok: async () => ({ path: '/contacts/search', query: { q: '0912700001' } }),
    readsContacts: async () => {
      const phone = nextPhone()
      await seedContact({ phone, name: 'Khách tra trùng C14b', ownerId: otherId })
      return { path: '/contacts/search', query: { q: phone } }
    },
  },
  // Deal
  'GET /deals': {
    ok: async () => ({ path: '/deals' }),
    bad: async () => ({ path: '/deals', query: { status: 'khong-co' } }),
    readsContacts: async () => {
      await mkDeal(saleId, await mkContact())
      return { path: '/deals' }
    },
  },
  'POST /deals': {
    ok: async () => ({ path: '/deals', body: { title: 'Deal tạo C14b', assigned_to: saleId } }),
    bad: async () => ({ path: '/deals', body: { title: '' } }),
  },
  'DELETE /deals/:id': {
    ok: async () => ({ path: `/deals/${await mkDeal()}` }),
    missing: { status: 404 },
    outOfScope: async () => ({ path: `/deals/${await mkDeal(otherId)}`, as: 'sale' }),
  },
  'GET /deals/:id': {
    ok: async () => ({ path: `/deals/${await mkDeal()}` }),
    missing: { status: 404 },
    outOfScope: async () => ({ path: `/deals/${await mkDeal(otherId)}`, as: 'sale' }),
    readsContacts: async () => ({ path: `/deals/${await mkDeal(saleId, await mkContact())}` }),
  },
  'PATCH /deals/:id': {
    ok: async () => ({ path: `/deals/${await mkDeal()}`, body: { title: 'Deal sửa C14b' } }),
    bad: async () => ({ path: `/deals/${await mkDeal()}`, body: { status: 'khong-co' } }),
    missing: { status: 404, body: { title: 'x' } },
    outOfScope: async () => ({ path: `/deals/${await mkDeal(otherId)}`, body: { title: 'x' }, as: 'sale' }),
  },
  'GET /deals/search-sales': {
    ok: async () => ({ path: '/deals/search-sales', query: { q: 'Contract' } }),
    readsContacts: async () => ({ path: '/deals/search-sales', query: { q: 'Contract' } }),
    usersOnly: true,
  },
  // Kanban
  'DELETE /kanban/attachments/:id': {
    ok: async () => {
      const { card } = await board2()
      const att = idOf(ok(await post(`/kanban/cards/${card}/attachments`, { url: 'https://example.com/a.pdf', title: 'Tệp' }), 201))
      return { path: `/kanban/attachments/${att}` }
    },
    missing: { status: 404 },
  },
  'GET /kanban/boards': { ok: async () => ({ path: '/kanban/boards' }) },
  'POST /kanban/boards': {
    ok: async () => ({ path: '/kanban/boards', body: { name: 'Bảng tạo C14b', visibility_role_ids: [] } }),
    bad: async () => ({ path: '/kanban/boards', body: { name: '' } }),
  },
  'POST /kanban/boards/:boardId/columns': {
    ok: async () => ({ path: `/kanban/boards/${await mkBoard()}/columns`, body: { name: 'Cột mới' } }),
    bad: async () => ({ path: `/kanban/boards/${await mkBoard()}/columns`, body: { name: '' } }),
    missing: { status: 404, body: { name: 'Cột' } },
  },
  'POST /kanban/boards/:boardId/columns/reorder': {
    ok: async () => {
      const { board, col, col2 } = await board2()
      return { path: `/kanban/boards/${board}/columns/reorder`, body: { column_ids: [col2, col] } }
    },
    bad: async () => ({ path: `/kanban/boards/${await mkBoard()}/columns/reorder`, body: { column_ids: [] } }),
    missing: { status: 404, body: { column_ids: [1] } },
  },
  'POST /kanban/boards/:boardId/field-defs': {
    ok: async () => ({ path: `/kanban/boards/${await mkBoard()}/field-defs`, body: { key: 'muc_do', label: 'Mức độ', type: 'text' } }),
    bad: async () => ({ path: `/kanban/boards/${await mkBoard()}/field-defs`, body: { key: 'Sai Khoá', label: 'x', type: 'text' } }),
    missing: { status: 404, body: { key: 'muc_do', label: 'Mức độ', type: 'text' } },
  },
  'POST /kanban/boards/:boardId/field-defs/reorder': {
    ok: async () => {
      const board = await mkBoard()
      const a = idOf(ok(await post(`/kanban/boards/${board}/field-defs`, { key: 'a1', label: 'A', type: 'text' }), 201))
      const b = idOf(ok(await post(`/kanban/boards/${board}/field-defs`, { key: 'b1', label: 'B', type: 'text' }), 201))
      return { path: `/kanban/boards/${board}/field-defs/reorder`, body: { field_def_ids: [b, a] } }
    },
    bad: async () => ({ path: `/kanban/boards/${await mkBoard()}/field-defs/reorder`, body: { field_def_ids: [] } }),
    // Id cột/trường không có trong thân kiểm trước khi tìm board: Node trả 400.
    missing: { status: 400, body: { field_def_ids: [1] } },
  },
  'DELETE /kanban/boards/:id': {
    ok: async () => ({ path: `/kanban/boards/${await mkBoard()}` }),
    missing: { status: 404 },
  },
  'GET /kanban/boards/:id': {
    ok: async () => ({ path: `/kanban/boards/${await mkBoard()}` }),
    missing: { status: 404 },
  },
  'PATCH /kanban/boards/:id': {
    ok: async () => ({ path: `/kanban/boards/${await mkBoard()}`, body: { name: 'Bảng đổi tên' } }),
    bad: async () => ({ path: `/kanban/boards/${await mkBoard()}`, body: { is_active: 'x' } }),
    missing: { status: 404, body: { name: 'x' } },
  },
  'POST /kanban/boards/:id/labels': {
    ok: async () => ({ path: `/kanban/boards/${await mkBoard()}/labels`, body: { name: 'Nhãn', color: '#198754' } }),
    bad: async () => ({ path: `/kanban/boards/${await mkBoard()}/labels`, body: { name: 'Nhãn', color: 'xanh' } }),
    missing: { status: 404, body: { name: 'Nhãn', color: '#198754' } },
  },
  'DELETE /kanban/boards/:id/labels/:labelId': {
    ok: async () => {
      const board = await mkBoard()
      return { path: `/kanban/boards/${board}/labels/${await mkLabel(board)}` }
    },
    missing: { status: 404 },
  },
  'PATCH /kanban/boards/:id/labels/:labelId': {
    ok: async () => {
      const board = await mkBoard()
      return { path: `/kanban/boards/${board}/labels/${await mkLabel(board)}`, body: { name: 'Đổi tên nhãn' } }
    },
    bad: async () => {
      const board = await mkBoard()
      return { path: `/kanban/boards/${board}/labels/${await mkLabel(board)}`, body: { color: 'xanh' } }
    },
    missing: { status: 404, body: { name: 'x' } },
  },
  'POST /kanban/boards/from-template': {
    ok: async () => ({ path: '/kanban/boards/from-template', body: { template_key: 'sales' } }),
    bad: async () => ({ path: '/kanban/boards/from-template', body: { template_key: 'khong-co' } }),
  },
  'GET /kanban/boards/templates': { ok: async () => ({ path: '/kanban/boards/templates' }) },
  'GET /kanban/cards': {
    ok: async () => ({ path: '/kanban/cards', query: { board_id: String((await board2()).board) } }),
    bad: async () => ({ path: '/kanban/cards', query: { board_id: '0' } }),
  },
  'POST /kanban/cards': {
    ok: async () => ({ path: '/kanban/cards', body: { column_id: await mkColumn(await mkBoard()), title: 'Thẻ tạo C14b' } }),
    bad: async () => ({ path: '/kanban/cards', body: { title: '' } }),
  },
  'GET /kanban/cards/:cardId/attachments': {
    ok: async () => ({ path: `/kanban/cards/${(await board2()).card}/attachments` }),
    missing: { status: 404 },
  },
  'POST /kanban/cards/:cardId/attachments': {
    ok: async () => ({ path: `/kanban/cards/${(await board2()).card}/attachments`, body: { url: 'https://example.com/b.pdf' } }),
    bad: async () => ({ path: `/kanban/cards/${(await board2()).card}/attachments`, body: { url: 'khong-phai-url' } }),
    missing: { status: 404, body: { url: 'https://example.com/b.pdf' } },
  },
  'GET /kanban/cards/:cardId/checklist-items': {
    ok: async () => ({ path: `/kanban/cards/${(await board2()).card}/checklist-items` }),
    missing: { status: 404 },
  },
  'POST /kanban/cards/:cardId/checklist-items': {
    ok: async () => ({ path: `/kanban/cards/${(await board2()).card}/checklist-items`, body: { text: 'Việc mới' } }),
    bad: async () => ({ path: `/kanban/cards/${(await board2()).card}/checklist-items`, body: { text: '' } }),
    missing: { status: 404, body: { text: 'Việc' } },
  },
  'POST /kanban/cards/:cardId/checklist-items/reorder': {
    ok: async () => {
      const { card } = await board2()
      const a = await mkItem(card)
      const b = await mkItem(card)
      return { path: `/kanban/cards/${card}/checklist-items/reorder`, body: { item_ids: [b, a] } }
    },
    bad: async () => ({ path: `/kanban/cards/${(await board2()).card}/checklist-items/reorder`, body: { item_ids: [] } }),
    missing: { status: 404, body: { item_ids: [1] } },
  },
  'DELETE /kanban/cards/:id': {
    ok: async () => ({ path: `/kanban/cards/${(await board2()).card}` }),
    missing: { status: 404 },
  },
  'GET /kanban/cards/:id': {
    ok: async () => ({ path: `/kanban/cards/${(await board2()).card}` }),
    missing: { status: 404 },
  },
  'PATCH /kanban/cards/:id': {
    ok: async () => ({ path: `/kanban/cards/${(await board2()).card}`, body: { title: 'Thẻ đổi tên' } }),
    bad: async () => ({ path: `/kanban/cards/${(await board2()).card}`, body: { title: '' } }),
    missing: { status: 404, body: { title: 'x' } },
  },
  'GET /kanban/cards/:id/activities': {
    ok: async () => ({ path: `/kanban/cards/${(await board2()).card}/activities` }),
    missing: { status: 404 },
  },
  'POST /kanban/cards/:id/comments': {
    ok: async () => ({ path: `/kanban/cards/${(await board2()).card}/comments`, body: { content: 'Bình luận' } }),
    bad: async () => ({ path: `/kanban/cards/${(await board2()).card}/comments`, body: { content: '' } }),
    missing: { status: 404, body: { content: 'x' } },
  },
  'POST /kanban/cards/:id/move': {
    ok: async () => {
      const { card, col2 } = await board2()
      return { path: `/kanban/cards/${card}/move`, body: { column_id: col2 } }
    },
    bad: async () => ({ path: `/kanban/cards/${(await board2()).card}/move`, body: {} }),
    missing: { status: 404, body: { column_id: 1 } },
  },
  'POST /kanban/cards/:id/restore': {
    ok: async () => {
      const { card } = await board2()
      ok(await send('DELETE', `/kanban/cards/${card}`, { token: tokens.admin }), 200)
      return { path: `/kanban/cards/${card}/restore` }
    },
    missing: { status: 404 },
  },
  'DELETE /kanban/checklist-items/:id': {
    ok: async () => ({ path: `/kanban/checklist-items/${await mkItem((await board2()).card)}` }),
    missing: { status: 404 },
  },
  'PATCH /kanban/checklist-items/:id': {
    ok: async () => ({ path: `/kanban/checklist-items/${await mkItem((await board2()).card)}`, body: { is_done: true } }),
    bad: async () => ({ path: `/kanban/checklist-items/${await mkItem((await board2()).card)}`, body: { is_done: 'x' } }),
    missing: { status: 404, body: { is_done: true } },
  },
  'DELETE /kanban/columns/:id': {
    ok: async () => ({ path: `/kanban/columns/${await mkColumn(await mkBoard())}` }),
    missing: { status: 404 },
  },
  'PATCH /kanban/columns/:id': {
    ok: async () => ({ path: `/kanban/columns/${await mkColumn(await mkBoard())}`, body: { name: 'Cột đổi tên' } }),
    bad: async () => ({ path: `/kanban/columns/${await mkColumn(await mkBoard())}`, body: { wip_limit: 0 } }),
    missing: { status: 404, body: { name: 'x' } },
  },
  'DELETE /kanban/field-defs/:id': {
    ok: async () => {
      const board = await mkBoard()
      return { path: `/kanban/field-defs/${idOf(ok(await post(`/kanban/boards/${board}/field-defs`, { key: 'xoa_toi', label: 'X', type: 'text' }), 201))}` }
    },
    missing: { status: 404 },
  },
  'PATCH /kanban/field-defs/:id': {
    ok: async () => {
      const board = await mkBoard()
      const id = idOf(ok(await post(`/kanban/boards/${board}/field-defs`, { key: 'sua_toi', label: 'X', type: 'text' }), 201))
      return { path: `/kanban/field-defs/${id}`, body: { label: 'Nhãn mới' } }
    },
    bad: async () => {
      const board = await mkBoard()
      const id = idOf(ok(await post(`/kanban/boards/${board}/field-defs`, { key: 'sua_toi', label: 'X', type: 'text' }), 201))
      return { path: `/kanban/field-defs/${id}`, body: { label: 5 } }
    },
    missing: { status: 404, body: { label: 'x' } },
  },
}

// ---- Bộ chạy -------------------------------------------------------------------------------------------------------
const declared: Record<string, Kind[]> = {}
for (const [key, r] of Object.entries(RECIPES)) {
  declared[key] = [...(r.bad ? (['badInput'] as Kind[]) : []), ...(r.missing ? (['missing'] as Kind[]) : []), ...(r.outOfScope ? (['outOfScope'] as Kind[]) : []), ...(r.readsContacts && !r.usersOnly ? (['masked'] as Kind[]) : [])]
}

/** Đường dẫn với mọi tham số `:xxx` thay bằng `value`. */
const fill = (p: string, value: string | number): string => p.replace(/:[A-Za-z]+/g, String(value))

beforeAll(async () => {
  tokens.admin = (await loginAdmin()).token
  const sale = await seedUser({
    label: 'c14b-sale',
    grants: {
      'contacts.view': 'own', 'contacts.create': 'own', 'contacts.update': 'own', 'contacts.delete': 'own', 'contacts.transfer': 'own', 'contacts.export': 'own',
      'deals.view': 'own', 'deals.manage': 'own', 'deals.delete': 'own', 'kanban.view': 'own', 'kanban.manage': 'own',
    },
  })
  saleId = sale.id
  tokens.sale = (await loginSeeded(sale)).token
  otherId = (await seedUser({ label: 'c14b-other', grants: {} })).id
  nobody = (await loginSeeded(await seedUser({ label: 'c14b-nobody', grants: {} }))).token
  sourceId = (await q<{ id: number }>(`SELECT id FROM setting_options WHERE group_key = 'contact_source' ORDER BY id LIMIT 1`))[0].id
}, 60_000)

const tokenFor = (r: Role): string => tokens[r]

describe.each(routes.map((r) => [keyOf(r), r] as [string, RouteDef]))('%s', (key, route) => {
  const recipe = RECIPES[key]
  const generic = (): string => fill(route.path.replace(/^\/api\/v1/, ''), 1)

  it('có công thức', () => {
    expect(recipe, `route ${key} chưa có công thức trong RECIPES`).toBeDefined()
  })

  it('thiếu token ⇒ 401', async () => {
    const res = await send(route.method, generic())
    expect(res.status).toBe(401)
    mark(key, 'unauth')
  })

  it.skipIf(route.access !== 'can')('không có quyền ⇒ 403', async () => {
    const res = await send(route.method, generic(), { token: nobody, body: {} })
    expect(res.status).toBe(403)
    mark(key, 'forbid')
  })

  it.skipIf(route.param_pipes.length === 0)('id sai kiểu ⇒ 400', async () => {
    // Thân hợp lệ (lấy từ công thức) để lỗi duy nhất là id: pipe thân chạy trước pipe tham số.
    const body = recipe ? (await recipe.ok()).body : {}
    const res = await send(route.method, fill(route.path.replace(/^\/api\/v1/, ''), BAD_ID), { token: tokens.admin, body })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toContain('Validation failed (numeric string is expected)')
    mark(key, 'badId')
  })

  it('thành công đúng mã hợp đồng', async () => {
    if (!recipe) return
    const c = await recipe.ok()
    const res = await send(route.method, c.path, { token: tokenFor(c.as ?? 'admin'), body: c.body, query: c.query })
    ok(res, route.status_ok ?? 200)
    c.check?.(res)
    mark(key, 'ok')
  })

  it.skipIf(!RECIPES[key]?.bad)('đầu vào sai ⇒ 400', async () => {
    const c = await recipe.bad!()
    const res = await send(route.method, c.path, { token: tokens.admin, body: c.body, query: c.query })
    expect(res.status).toBe(400)
    if (c.text) expect(JSON.stringify(res.body)).toContain(c.text)
    golden(`route-bad-${key.replace(/[^a-z0-9]+/gi, '-')}`, 'admin', snap(res))
    mark(key, 'badInput')
  })

  it.skipIf(!RECIPES[key]?.missing)('id không có ⇒ mã đã định', async () => {
    const m = recipe.missing!
    const res = await send(route.method, fill(route.path.replace(/^\/api\/v1/, ''), MISSING), { token: tokens.admin, body: m.body })
    expect(res.status).toBe(m.status)
    golden(`route-missing-${key.replace(/[^a-z0-9]+/gi, '-')}`, 'admin', snap(res))
    mark(key, 'missing')
  })

  it.skipIf(!RECIPES[key]?.outOfScope)('ngoài phạm vi theo id ⇒ 404', async () => {
    const c = await recipe.outOfScope!()
    const res = await send(route.method, c.path, { token: tokenFor(c.as ?? 'sale'), body: c.body, query: c.query })
    expect(res.status).toBe(recipe.outOfScopeStatus ?? 404)
    golden(`route-out-of-scope-${key.replace(/[^a-z0-9]+/gi, '-')}`, 'sale', snap(res))
    mark(key, 'outOfScope')
  })

  it.skipIf(!RECIPES[key]?.readsContacts)('route đọc dữ liệu khách: golden 3 vai, SĐT bị che với vai không có contacts.phone_full', async () => {
    const c = await recipe.readsContacts!()
    let saleBody = ''
    for (const [role, token] of await threeRoleTokens(tokens.sale)) {
      const res = await send(route.method, c.path, { token, query: c.query })
      if (!recipe.usersOnly) expect(res.status, role).toBe(200)
      golden(`route-3roles-${key.replace(/[^a-z0-9]+/gi, '-')}`, role, snap(res))
      if (role === 'sale') saleBody = JSON.stringify(res.body)
    }
    // Vai sale (không có contacts.phone_full): không có SĐT đầy đủ nào của dữ liệu seed `0912xxxxxx` trong response.
    expect(saleBody).not.toMatch(/0912\d{6}/)
    mark(key, 'golden3')
    if (!recipe.usersOnly) mark(key, 'masked')
  })
})

describe('độ phủ route cụm khách hàng, deal, kanban', () => {
  it('mọi route của cụm có đủ loại ca (100%)', () => {
    expect(routes.length).toBe(56)
    const cov = coverage(routes, declared)
    // eslint-disable-next-line no-console
    console.log(`[C14b] độ phủ route: ${cov.complete}/${cov.total}`)
    expect(cov.missing, cov.missing.join('\n')).toEqual([])
    expect(cov.complete).toBe(cov.total)
  })
})
