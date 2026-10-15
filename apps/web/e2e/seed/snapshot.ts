import type { Api } from '../helpers/api'

/**
 * ẢNH CHỤP số bản ghi đang hoạt động, tách THẬT (không `E2E-`) và THỬ (`E2E-`). Seed chụp trước,
 * cleanup chụp sau: `real` phải bằng nhau và `e2e` phải rỗng. Chỉ dùng API đọc.
 */
export interface Snapshot {
  real: Record<string, number>
  e2e: { kind: string; id: number | string; label: string }[]
}

// Đúng dạng `E2E-<13 chữ số timestamp>` do prefix() sinh (hoa/thường đều được, vì email bị hạ chữ thường):
// bản ghi thật chỉ nhắc "e2e-" trong tên KHÔNG bị quét xoá.
const E2E = /\bE2E-\d{13}\b/i

type Row = Record<string, unknown>

/** Chỉ endpoint có thể bị TẮT bằng cờ máy chủ (webhook) mới được nuốt lỗi; còn lại lỗi phải ồn ào (không đếm sai im lặng). */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}
const loud = <T>(fn: () => Promise<T>): Promise<T> => fn()

export async function takeSnapshot(api: Api): Promise<Snapshot> {
  const real: Record<string, number> = {}
  const e2e: Snapshot['e2e'] = []
  const tally = (kind: string, rows: Row[], label: (r: Row) => string, id: (r: Row) => number | string = (r) => r.id as number) => {
    real[kind] = 0
    for (const r of rows) {
      const l = label(r)
      if (E2E.test(l)) e2e.push({ kind, id: id(r), label: l })
      else real[kind]++
    }
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : '')

  const contacts = await loud(() => api.get<{ data: Row[] }>('/contacts?limit=200'))
  tally('contact', contacts.data, (r) => str(r.full_name))
  tally('product', await loud(() => api.get<Row[]>('/products')).then((a) => a.filter((p) => p.is_active)), (r) => str(r.name))
  tally('project', await loud(() => api.get<Row[]>('/projects')), (r) => `${str(r.name)} ${str(r.code)}`)
  tally('role', await loud(() => api.get<Row[]>('/roles')), (r) => str(r.name))
  tally('user', (await loud(() => api.get<{ data: Row[] }>('/users?limit=200'))).data, (r) => `${str(r.full_name)} ${str(r.email)}`)
  tally('newsfeed', (await loud(() => api.get<{ data: Row[] }>('/newsfeed?limit=50'))).data, (r) => str(r.content))
  tally('kanban-board', await loud(() => api.get<Row[]>('/kanban/boards')), (r) => str(r.name))
  // Hồ sơ nhân viên: danh sách /management/employees ẨN nhân viên đã nghỉ, còn /management/contracts liệt kê MỌI hồ sơ
  // chưa xoá mềm (kể cả đã nghỉ, chưa có hợp đồng) ⇒ lấy nhân viên từ danh sách hợp đồng để không sót.
  const contractRows = (await loud(() => api.get<{ data: Row[] }>('/management/contracts?page_size=100'))).data
  tally('employee', contractRows.map((r) => r.employee as Row), (r) => `${str(r.full_name)} ${str(r.email)}`)
  tally('job-title', await loud(() => api.get<Row[]>('/management/job-titles')), (r) => `${str(r.name)} ${str(r.rank_code)}`)
  tally('contract', contractRows.filter((r) => r.id !== null), (r) => `${str((r.employee as Row | undefined)?.full_name)} ${str(r.notes)}`)
  tally('candidate', (await loud(() => api.get<{ data: Row[] }>('/management/recruitment/candidates?page_size=100'))).data, (r) => str(r.full_name))
  tally('position', (await loud(() => api.get<{ data: Row[] }>('/management/recruitment/positions?page_size=100'))).data, (r) => `${str(r.position_title)} ${str(r.job_code)}`)
  tally('deal', (await loud(() => api.get<{ data: Row[] }>('/deals?limit=100'))).data, (r) => str(r.title))
  tally('webhook-out', (await safe(() => api.get<{ data: Row[] }>('/integrations/webhooks/endpoints'), { data: [] })).data, (r) => str(r.name))
  tally('webhook-in', (await safe(() => api.get<{ data: Row[] }>('/integrations/webhooks/inbound-sources'), { data: [] })).data, (r) => str(r.name))
  tally('api-key', (await loud(() => api.get<Row[]>('/api-keys'))).filter((k) => !k.revoked_at), (r) => str(r.name))
  // Tính năng tuỳ biến: khoá `key` làm id (DELETE /custom-objects/:key). Endpoint chưa có ở bản cũ → bỏ qua, không đếm sai.
  tally('custom-object', await safe(() => api.get<Row[]>('/custom-objects'), []), (r) => `${str(r.label)} ${str(r.key)}`, (r) => str(r.key))
  tally('option', (await loud(() => api.get<{ data: Row[] }>('/settings/options?group=contact_source&active=true'))).data, (r) => `${str(r.label)} ${str(r.value)}`)

  // Kết nối AI (OAuth) còn hiệu lực của client E2E- (token chưa thu hồi).
  const conns = await safe(() => api.get<{ data: Row[] }>('/integrations/ai-connections?scope=all'), { data: [] })
  for (const c of conns.data) if (E2E.test(str(c.client_name))) e2e.push({ kind: 'ai-connection', id: c.id as string, label: str(c.client_name) })

  // Thẻ Kanban: chỉ đếm theo board còn hoạt động.
  const boards = await loud(() => api.get<Row[]>('/kanban/boards'))
  let cards = 0
  for (const b of boards) {
    const r = await loud(() => api.get<{ cards: Row[] }>(`/kanban/cards?board_id=${b.id as number}&limit=100`))
    for (const c of r.cards) {
      if (E2E.test(str(c.title))) e2e.push({ kind: 'kanban-card', id: c.id as number, label: str(c.title) })
      else cards++
    }
  }
  real['kanban-card'] = cards
  return { real, e2e }
}
