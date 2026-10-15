import fs from 'node:fs'
import { test as teardown, expect } from '@playwright/test'
import { Api } from '../helpers/api'
import { WRITE_ENABLED, WRITE_SKIP_REASON } from '../helpers/data'
import { MANIFEST_PATH, RESIDUAL_PATH, readManifest, writeManifest, type ManifestEntry } from '../helpers/manifest'
import { hasRole, type RoleKey } from '../helpers/roles'
import { takeSnapshot } from './snapshot'

/**
 * CLEANUP — teardown của project `seed`: chạy SAU mọi project phụ thuộc, KỂ CẢ khi test đỏ.
 *  1. Xoá theo manifest NGƯỢC thứ tự (con trước cha) qua API (không SQL, không ssh).
 *  2. Bản ghi mà API chỉ xoá mềm / không có API xoá → ghi `e2e/.cleanup-residual.json` (bảng + id)
 *     để người vận hành xoá hẳn.
 *  3. Quét lại bằng API: không còn `E2E-` đang hoạt động; số bản ghi THẬT bằng trước-seed.
 * Chạy riêng: `E2E_ALLOW_WRITE=1 pnpm exec playwright test --project=cleanup`.
 */
teardown.skip(!WRITE_ENABLED, WRITE_SKIP_REASON)
teardown.setTimeout(240_000)

interface Residual { table: string; id: number | string; label: string; note: string }

/** Đường xoá cho quét sót theo loại (bản ghi E2E- không có trong manifest, vd lần chạy cũ bị kill). */
const SWEEP_URL: Record<string, (id: number | string) => string> = {
  contact: (id) => `/contacts/${id}`,
  product: (id) => `/products/${id}`,
  project: (id) => `/projects/${id}`,
  role: (id) => `/roles/${id}`,
  user: (id) => `/users/${id}/permanent`,
  newsfeed: (id) => `/newsfeed/${id}`,
  'ai-connection': (id) => `/integrations/ai-connections/${id}`,
  'kanban-board': (id) => `/kanban/boards/${id}`,
  'kanban-card': (id) => `/kanban/cards/${id}`,
  employee: (id) => `/management/employees/${id}`,
  'job-title': (id) => `/management/job-titles/${id}`,
  candidate: (id) => `/management/recruitment/candidates/${id}`,
  position: (id) => `/management/recruitment/positions/${id}`,
  deal: (id) => `/deals/${id}`,
  'webhook-out': (id) => `/integrations/webhooks/endpoints/${id}`,
  'webhook-in': (id) => `/integrations/webhooks/inbound-sources/${id}`,
  'api-key': (id) => `/api-keys/${id}`,
  option: (id) => `/settings/options/${id}`,
  'custom-object': (id) => `/custom-objects/${id}`,
}

/** Loại mà DELETE qua API chỉ xoá MỀM → bảng còn lại (cho residual khi quét sót). */
const SWEEP_SOFT: Record<string, string> = {
  contact: 'contacts', project: 'projects', user: 'users', employee: 'employees',
  'kanban-board': 'kanban_boards', 'kanban-card': 'kanban_cards', 'api-key': 'api_keys', option: 'setting_options', 'custom-object': 'custom_objects',
}

teardown('dọn dữ liệu thử E2E- và kiểm trạng thái sạch', async () => {
  const apis = new Map<RoleKey, Api>()
  const apiFor = async (r: RoleKey) => {
    if (!apis.has(r)) apis.set(r, await Api.forRole(r))
    return apis.get(r)!
  }
  const manifest = readManifest()
  const residual: Residual[] = []
  const failed: string[] = []
  const entries: ManifestEntry[] = [...(manifest?.entries ?? [])].reverse()

  for (const e of entries) {
    const role = e.as ?? 'ADMIN'
    if (!hasRole(role)) continue
    const api = await apiFor(role)
    for (const p of e.pre ?? []) await api.call(p.method, p.url, p.data ?? {}).catch(() => undefined)
    if (e.del) {
      const status = await api.del(e.del).catch(() => 0)
      if (status >= 300 && status !== 404 && status !== 410) {
        failed.push(`${e.kind}#${e.id} ${e.del} → HTTP ${status}`)
        if (e.soft) residual.push({ ...e.soft, id: e.id, label: e.label, note: `${e.soft.note} — DELETE lỗi HTTP ${status}, cần xoá tay` })
        continue
      }
    }
    if (e.soft) residual.push({ table: e.soft.table, id: e.id, label: e.label, note: e.soft.note })
  }

  // Đề xuất AI còn chờ duyệt do E2E tạo (lần chạy cũ bị kill giữa chừng) → từ chối + ghi residual.
  if (hasRole('ADMIN')) {
    const pend = await (await apiFor('ADMIN')).get<{ data: { id: number; summary: string }[] }>('/integrations/ai-actions?status=pending&limit=50').catch(() => ({ data: [] }))
    for (const d of pend.data.filter((x) => /E2E-/.test(x.summary))) {
      await (await apiFor('ADMIN')).call('POST', `/integrations/ai-actions/${d.id}/reject`, {}).catch(() => undefined)
      residual.push({ table: 'ai_action_drafts', id: d.id, label: `đề xuất AI ${d.id}`, note: 'quét sót — đã từ chối; không có API xoá' })
    }
  }

  // Quét sót: bản ghi E2E- còn hoạt động ngoài manifest.
  const admin = await apiFor('ADMIN')
  let snap = await takeSnapshot(admin)
  for (const l of snap.e2e) {
    const url = SWEEP_URL[l.kind]?.(l.id)
    if (!url) continue
    const st = await admin.del(url).catch(() => 0)
    const soft = SWEEP_SOFT[l.kind]
    if (soft && st > 0 && st < 300) residual.push({ table: soft, id: l.id, label: l.label, note: 'quét sót (không có trong manifest — lần chạy cũ) — xoá mềm' })
  }
  if (snap.e2e.length) snap = await takeSnapshot(admin)

  // Ghi residual (gộp với lần trước nếu chưa được xoá hẳn).
  let prev: Residual[] = []
  try { prev = JSON.parse(fs.readFileSync(RESIDUAL_PATH, 'utf8')).records as Residual[] } catch { /* chưa có */ }
  const seen = new Set<string>()
  const merged = [...prev, ...residual].filter((r) => !seen.has(`${r.table}:${r.id}`) && seen.add(`${r.table}:${r.id}`))
  const byTable: Record<string, (number | string)[]> = {}
  for (const r of merged) (byTable[r.table] ??= []).push(r.id)
  fs.writeFileSync(RESIDUAL_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), note: 'Bản ghi E2E- chỉ xoá mềm được qua API — vận hành xoá hẳn (không chạy SQL từ test).', byTable, records: merged }, null, 2))

  const baseline = manifest?.baseline
  for (const a of apis.values()) await a.dispose()
  if (manifest) writeManifest({ ...manifest, entries: failed.length ? manifest.entries : [] })
  else fs.rmSync(MANIFEST_PATH, { force: true })

  expect(failed, `Xoá lỗi:\n${failed.join('\n')}`).toEqual([])
  expect(snap.e2e, `Còn bản ghi E2E- đang hoạt động sau dọn: ${JSON.stringify(snap.e2e)}`).toEqual([])
  if (baseline) expect(snap.real, 'Số bản ghi THẬT sau dọn phải bằng trước seed').toEqual(baseline)
})
