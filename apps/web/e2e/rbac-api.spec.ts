import { test, expect, request as pwRequest } from '@playwright/test'
import { can, type Permission } from '@trinity/rbac'
import { ROLES, ROLE_LABEL, hasRole, missingEnvReason } from './helpers/roles'
import { Api, BASE_URL, type MeResponse } from './helpers/api'
import { seeded } from './helpers/manifest'
import { inScope, ownerIdsFor, scopeOf, type OrgUser } from './helpers/scope'
import { userIds } from './seed/lib'
import { bypassHeaders } from './helpers/vercel-bypass'

/**
 * RBAC QUA API — ma trận quyền theo 5 tài khoản E2E (admin, hr, dept_head, lead, sale). Kỳ vọng tính từ
 * `permissions` của CHÍNH phiên (`/auth/me`), không hardcode vai trò nào có gì.
 *   - GET theo quyền: có quyền → 200, không → 403.
 *   - GHI không quyền → 403 (body rỗng: guard chạy trước validate); có quyền → KHÔNG 403.
 *   - Phạm vi own/team/subtree/all trên khách/deal/thẻ kanban của bộ seed.
 *   - SĐT che theo `contacts.phone_full`; ngoài phạm vi theo id → 404 (không 403).
 *   - Không token → 401.
 * Cần seed (E2E_ALLOW_WRITE=1) cho các ca dữ liệu; ca ma trận quyền chạy được không cần seed.
 */
interface Probe {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  /** Quyền cần (một trong các quyền = CanAny). Bỏ trống = @AuthOnly. */
  perm?: Permission | Permission[]
}

const month = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7)

const READS: Probe[] = [
  { method: 'GET', url: '/auth/me' },
  { method: 'GET', url: '/settings/org-features' },
  { method: 'GET', url: '/newsfeed?limit=1' },
  { method: 'GET', url: '/contacts?limit=1', perm: 'contacts.view' },
  { method: 'GET', url: '/deals?limit=1', perm: 'deals.view' },
  { method: 'GET', url: '/kanban/boards', perm: 'kanban.view' },
  { method: 'GET', url: '/products', perm: 'products.view' },
  { method: 'GET', url: '/projects', perm: 'products.view' },
  { method: 'GET', url: '/pos/shifts/current', perm: 'pos.sell' },
  { method: 'GET', url: '/management/employees?page_size=1', perm: 'employees.view' },
  { method: 'GET', url: '/management/contracts?page_size=1', perm: 'contracts.view' },
  { method: 'GET', url: '/management/recruitment/candidates?page_size=1', perm: 'recruitment.view' },
  { method: 'GET', url: '/management/attendance?page_size=1', perm: 'attendance.view' },
  { method: 'GET', url: '/management/attendance/requests?page_size=1', perm: 'attendance.view' },
  { method: 'GET', url: `/payslips?month=${month}`, perm: 'payroll.view' },
  { method: 'GET', url: `/payslips/me?month=${month}` },
  { method: 'GET', url: '/users?limit=1', perm: 'users.view' },
  { method: 'GET', url: '/roles', perm: ['roles.manage', 'users.manage', 'kanban.boards'] },
  { method: 'GET', url: '/api-keys', perm: 'settings.integrations' },
  { method: 'GET', url: '/integrations/webhooks/endpoints', perm: 'integrations.webhooks' },
  { method: 'GET', url: '/integrations/audit-logs?limit=1', perm: 'integrations.ai_admin' },
  { method: 'GET', url: '/integrations/ai-connections', perm: ['integrations.ai_connect', 'integrations.ai_admin'] },
  { method: 'GET', url: '/integrations/ai-actions', perm: undefined },
]

const WRITES: Probe[] = [
  { method: 'POST', url: '/contacts', perm: 'contacts.create' },
  { method: 'DELETE', url: '/contacts/2147483000', perm: 'contacts.delete' },
  { method: 'POST', url: '/deals', perm: 'deals.manage' },
  { method: 'DELETE', url: '/deals/2147483000', perm: 'deals.delete' },
  { method: 'POST', url: '/kanban/boards', perm: 'kanban.boards' },
  { method: 'POST', url: '/products', perm: 'products.manage' },
  { method: 'POST', url: '/projects', perm: 'products.manage' },
  { method: 'POST', url: '/management/employees', perm: 'employees.manage' },
  { method: 'POST', url: '/management/contracts', perm: 'contracts.manage' },
  { method: 'POST', url: '/management/job-titles', perm: 'org.manage' },
  { method: 'POST', url: '/management/recruitment/candidates', perm: 'recruitment.manage' },
  { method: 'PATCH', url: '/management/attendance/settings', perm: 'attendance.config' },
  { method: 'POST', url: '/management/attendance/requests/2147483000/approve', perm: 'attendance.manage' },
  { method: 'POST', url: '/payslips/generate', perm: 'payroll.manage' },
  { method: 'POST', url: '/users', perm: 'users.manage' },
  { method: 'POST', url: '/roles', perm: 'roles.manage' },
  { method: 'PUT', url: '/settings/org-features', perm: 'settings.features' },
  { method: 'POST', url: '/settings/options', perm: 'contacts.catalog' },
  { method: 'POST', url: '/api-keys', perm: 'settings.integrations' },
  { method: 'POST', url: '/integrations/webhooks/endpoints', perm: 'integrations.webhooks' },
  { method: 'POST', url: '/pos/shifts/2147483000/close', perm: 'pos.sell' },
]

const allowed = (me: MeResponse, perm: Probe['perm']): boolean => {
  if (!perm) return true
  return (Array.isArray(perm) ? perm : [perm]).some((p) => can(me.permissions, p))
}

for (const role of ROLES) {
  test.describe(`rbac-api · ${role} (${ROLE_LABEL[role]})`, () => {
    test.skip(!hasRole(role), missingEnvReason(role))
    let api: Api
    let me: MeResponse
    let org: OrgUser[] = []
    let ids: Record<string, number> = {}

    test.beforeAll(async () => {
      api = await Api.forRole(role)
      me = await api.me()
      const admin = await Api.forRole('ADMIN')
      const users = await admin.get<{ data: OrgUser[] }>('/users?limit=200')
      org = users.data.map((u) => ({ id: u.id, manager_id: u.manager_id }))
      await admin.dispose()
      ids = await userIds(api)
    })
    test.afterAll(async () => {
      await api.dispose()
    })

    test('GET theo quyền: có quyền → 200, không → 403', async () => {
      const bad: string[] = []
      for (const p of READS) {
        const res = await api.call(p.method, p.url)
        const ok = allowed(me, p.perm)
        const st = res.status()
        if (ok && st !== 200) bad.push(`${p.url}: CÓ quyền (${JSON.stringify(p.perm)}) nhưng HTTP ${st}`)
        if (!ok && st !== 403) bad.push(`${p.url}: KHÔNG có quyền (${JSON.stringify(p.perm)}) nhưng HTTP ${st} (phải 403)`)
      }
      expect(bad, bad.join('\n')).toEqual([])
    })

    test('GHI: không quyền → 403; có quyền → không bị 403 (body rỗng nên 400/404 là bình thường)', async () => {
      const bad: string[] = []
      for (const p of WRITES) {
        // Có quyền thì KHÔNG gửi thật (tránh ghi dữ liệu thật): chỉ kiểm nhánh bị chặn. Nhánh có quyền đã được
        // các flow ghi kiểm bằng thao tác thật.
        if (allowed(me, p.perm)) continue
        const st = (await api.call(p.method, p.url, {})).status()
        if (st !== 403) bad.push(`${p.method} ${p.url}: thiếu ${JSON.stringify(p.perm)} nhưng HTTP ${st} (phải 403)`)
      }
      expect(bad, bad.join('\n')).toEqual([])
    })

    test('không token → 401 trên mọi route nghiệp vụ', async () => {
      const anon = await pwRequest.newContext({ extraHTTPHeaders: bypassHeaders() })
      const bad: string[] = []
      for (const p of READS.filter((r) => r.perm)) {
        const st = (await anon.get(`${BASE_URL}/api/v1${p.url}`)).status()
        if (st !== 401) bad.push(`${p.url} → HTTP ${st} (phải 401)`)
      }
      await anon.dispose()
      expect(bad, bad.join('\n')).toEqual([])
    })

    test('khách E2E-: thấy đúng tập theo phạm vi contacts.view; SĐT che theo contacts.phone_full', async () => {
      const mine = seeded('contact')
      test.skip(mine.length === 0, 'Chưa có dữ liệu seed (cần E2E_ALLOW_WRITE=1)')
      test.skip(!can(me.permissions, 'contacts.view'), 'Vai trò không có contacts.view')
      const set = ownerIdsFor(scopeOf(me.permissions, 'contacts.view'), me.user.id, org)
      const r = await api.get<{ data: { id: number; full_name: string; phone: string }[] }>('/contacts?limit=200&search=E2E-')
      const seen = new Map(r.data.filter((c) => /^E2E-/.test(c.full_name)).map((c) => [c.id, c]))
      const bad: string[] = []
      for (const e of mine) {
        const owner = ids[String(e.meta?.owner)]
        expect(owner, `không tra được user id của chủ ${e.meta?.owner}`).toBeGreaterThan(0)
        const expectSee = inScope(set, owner)
        const got = seen.get(Number(e.id))
        if (expectSee && !got) bad.push(`#${e.id} (chủ ${e.meta?.owner}) phải THẤY trong phạm vi ${String(scopeOf(me.permissions, 'contacts.view'))}`)
        if (!expectSee && got) bad.push(`#${e.id} (chủ ${e.meta?.owner}) NGOÀI phạm vi nhưng vẫn thấy`)
        if (got) {
          const full = String(e.meta?.phone)
          const isMasked = got.phone !== full
          const fullAllowed = can(me.permissions, 'contacts.phone_full')
          if (fullAllowed && isMasked) bad.push(`#${e.id}: có contacts.phone_full nhưng SĐT bị che (${got.phone})`)
          if (!fullAllowed && !isMasked) bad.push(`#${e.id}: KHÔNG có contacts.phone_full nhưng SĐT hiện đầy đủ`)
        }
      }
      expect(bad, bad.join('\n')).toEqual([])
    })

    test('khách ngoài phạm vi theo id → 404 (không phải 403, không lộ dữ liệu)', async () => {
      test.skip(!can(me.permissions, 'contacts.view'), 'Vai trò không có contacts.view')
      const set = ownerIdsFor(scopeOf(me.permissions, 'contacts.view'), me.user.id, org)
      const out = seeded('contact').find((e) => !inScope(set, ids[String(e.meta?.owner)]))
      test.skip(!out, 'Không có khách seed nào ngoài phạm vi của vai trò này (scope all hoặc chưa seed)')
      const res = await api.call('GET', `/contacts/${out!.id}`)
      expect(res.status(), 'Tài nguyên theo id ngoài phạm vi phải 404').toBe(404)
    })

    test('thẻ Kanban và deal E2E-: thấy đúng tập theo phạm vi', async () => {
      const cards = seeded('kanban-card').filter((c) => c.meta?.assignee)
      test.skip(cards.length === 0, 'Chưa có dữ liệu seed (cần E2E_ALLOW_WRITE=1)')
      const bad: string[] = []
      if (can(me.permissions, 'kanban.view')) {
        const set = ownerIdsFor(scopeOf(me.permissions, 'kanban.view'), me.user.id, org)
        const board = seeded('kanban-board')[0]
        const r = await api.get<{ cards: { id: number }[] }>(`/kanban/cards?board_id=${board.id}&limit=100`)
        const seen = new Set(r.cards.map((c) => c.id))
        for (const c of cards) {
          const owner = ids[String(c.meta?.assignee)]
          const want = inScope(set, owner)
          if (want !== seen.has(Number(c.id))) bad.push(`thẻ #${c.id} (giao ${c.meta?.assignee}): ${want ? 'phải THẤY' : 'phải ẨN'} với scope ${String(scopeOf(me.permissions, 'kanban.view'))}`)
        }
      }
      if (can(me.permissions, 'deals.view')) {
        const set = ownerIdsFor(scopeOf(me.permissions, 'deals.view'), me.user.id, org)
        const r = await api.get<{ data: { id: number }[] }>('/deals?limit=100')
        const seen = new Set(r.data.map((d) => d.id))
        for (const d of seeded('deal')) {
          const want = inScope(set, Number(d.meta?.assignee))
          if (want !== seen.has(Number(d.id))) bad.push(`deal #${d.id} (giao ${d.meta?.assignee}): ${want ? 'phải THẤY' : 'phải ẨN'} với scope ${String(scopeOf(me.permissions, 'deals.view'))}`)
        }
      }
      expect(bad, bad.join('\n')).toEqual([])
    })
  })
}
