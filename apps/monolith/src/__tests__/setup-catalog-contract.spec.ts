/**
 * Danh mục của M19 cho bản Rust (`server/crates/mod-setup`): mẫu bảng dựng sẵn (thực thể, trường, bản ghi mẫu với ngày thành
 * dấu hiệu), ngành + phân hệ gợi ý, prompt nối từng agent (địa chỉ MCP thành dấu hiệu). Dữ liệu thuần, sinh từ mã TS nên hai
 * bản không lệch. Sinh lại: `UPDATE_GOLDEN=1 pnpm --filter @trinity/monolith exec jest src/__tests__/setup-catalog-contract`.
 *
 * Bản ghi mẫu: sinh ở hai ngày khác nhau; chuỗi chứa ngày hôm nay thành `{today}`; giá trị chỉ đổi theo ngày mà không phải
 * chuỗi chứa ngày (`ket_thuc` = `bat_dau` + N tháng) thành `{"$add_months": "<trường số tháng>"}`; còn lại giữ nguyên, lệch
 * quy tắc nào thì spec lỗi để người sửa xem lại.
 */
import * as fs from 'fs'
import * as path from 'path'
import { INDUSTRY_KEYS, INDUSTRY_PRESETS, LOCKED_FEATURES, MAX_BUILD_FEATURES, ORG_FEATURE_KEYS } from '@trinity/rbac'

import { CUSTOM_OBJECT_TEMPLATES } from '../../../../services/crm/src/custom-objects/templates'
import { buildConnectPrompt, CONNECT_AGENTS, TRINITY_RULE } from '../../../../services/crm/src/setup/connect-prompts'

const FILE = path.resolve(__dirname, '../../../../server/contracts/setup/catalog.json')
const D1 = '2026-03-15'
const D2 = '2027-12-09'
const URL_MARK = '@@MCP_URL@@'

function addMonths(ymd: string, months: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1 + months, 1))
  const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(Math.min(d, last))}`
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

function tokenize(a: Json, b: Json, dataA: Record<string, Json>): Json {
  if (typeof a === 'string' && typeof b === 'string') {
    const ta = a.split(D1).join('{today}')
    const tb = b.split(D2).join('{today}')
    if (ta === tb) return ta
    throw new Error(`mẫu có giá trị phụ thuộc ngày chưa có quy tắc: ${a} / ${b}`)
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.map((x, i) => tokenize(x, b[i], dataA))
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out: { [k: string]: Json } = {}
    for (const k of Object.keys(a)) {
      const va = a[k]
      const vb = b[k]
      if (k === 'ket_thuc' && typeof va === 'string' && typeof vb === 'string' && typeof dataA.thoi_han_thang === 'number') {
        if (va !== addMonths(D1, dataA.thoi_han_thang) || vb !== addMonths(D2, dataA.thoi_han_thang)) throw new Error('ket_thuc lệch quy tắc cộng tháng')
        out[k] = { $add_months: 'thoi_han_thang' }
        continue
      }
      out[k] = tokenize(va, vb, dataA)
    }
    return out
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`giá trị khác nhau theo ngày: ${JSON.stringify(a)} / ${JSON.stringify(b)}`)
  return a
}

function build(): Json {
  const templates = CUSTOM_OBJECT_TEMPLATES.map((t) => {
    const s1 = t.samples(D1) as unknown as Array<{ object: string; data: Record<string, Json>; refs?: Json }>
    const s2 = t.samples(D2) as unknown as typeof s1
    if (s1.length !== s2.length) throw new Error('số bản ghi mẫu đổi theo ngày')
    const samples = s1.map((r, i) => {
      const rec: { [k: string]: Json } = { object: r.object, data: tokenize(r.data, s2[i].data, r.data) }
      if (r.refs) rec.refs = r.refs
      return rec
    })
    return { key: t.key, label: t.label, description: t.description, objects: t.objects as unknown as Json, samples }
  })
  const industries = INDUSTRY_KEYS.map((key) => ({ key, ...INDUSTRY_PRESETS[key] }))
  const prompts: Record<string, string> = {}
  for (const a of CONNECT_AGENTS) prompts[a.key] = buildConnectPrompt(a.key, URL_MARK)
  return {
    templates,
    industries: industries as unknown as Json,
    locked_features: [...LOCKED_FEATURES],
    max_build_features: MAX_BUILD_FEATURES,
    org_feature_keys: [...ORG_FEATURE_KEYS],
    connect: { url_mark: URL_MARK, agents: CONNECT_AGENTS.map(({ key, label }) => ({ key, label })), prompts, rule: TRINITY_RULE },
  } as Json
}

describe('hợp đồng danh mục setup cho bản Rust', () => {
  it('catalog.json khớp mã TS', () => {
    const text = JSON.stringify(build(), null, 2) + '\n'
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(FILE, text)
    expect(fs.readFileSync(FILE, 'utf8')).toBe(text)
  })

  it('prompt không lộ tên miền thật và không còn {URL}', () => {
    for (const p of Object.values((build() as { connect: { prompts: Record<string, string> } }).connect.prompts)) {
      expect(p).toContain(URL_MARK)
      expect(p).not.toContain('{URL}')
      expect(p).not.toMatch(/phanmemtrinity|aiilab/)
    }
  })
})
