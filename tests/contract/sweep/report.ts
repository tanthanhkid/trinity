/**
 * Báo cáo quét X13: CHỈ chứa tên route (mẫu, không id thật), số đếm, và đường dẫn+loại khác biệt. Không giá trị dữ liệu, không id,
 * không thân response, không thông điệp lỗi gốc. Khoá JSON trong đường dẫn khác biệt có thể là dữ liệu (response dạng từ điển
 * `{ "<tên khách>": … }`), nên mỗi đoạn đường dẫn phải là định danh thuần (chữ, số, gạch dưới, ≤ 40 ký tự, bắt đầu bằng chữ)
 * nếu không thì thay bằng `<key>`.
 */
import type { Diff } from './compare.js'

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/

export function redactPathEntry(entry: string): string {
  const bar = entry.lastIndexOf('|')
  const path = bar < 0 ? entry : entry.slice(0, bar)
  const kind = bar < 0 ? 'value' : entry.slice(bar + 1)
  const out = path
    .split('.')
    .map((seg) => {
      const arr = seg.endsWith('[]') ? '[]' : ''
      const name = arr ? seg.slice(0, -2) : seg
      if (name === '$' || name === '<content-type>' || name === '<body>') return seg
      return (IDENT.test(name) ? name : '<key>') + arr
    })
    .join('.')
  return `${out}|${kind}`
}

export interface RouteResult {
  route: string
  cached: boolean
  minSamples: number
  samples: number
  distinctRequests: number
  equal: number
  different: number
  statusMismatch: number
  /** Lỗi mạng/hết giờ (không phải khác biệt): chỉ đếm. */
  errors: number
  /** Tên tham số (`id`) chưa có quy tắc ánh xạ bảng, không có giá trị. */
  noSampler: string[]
  diffs: Map<string, number>
}

export function newResult(route: string, cached: boolean, minSamples: number): RouteResult {
  return { route, cached, minSamples, samples: 0, distinctRequests: 0, equal: 0, different: 0, statusMismatch: 0, errors: 0, noSampler: [], diffs: new Map() }
}

export function record(r: RouteResult, d: Diff): void {
  r.samples++
  if (d.statusMismatch) r.statusMismatch++
  if (d.entries.length > 0 || d.statusMismatch) r.different++
  else r.equal++
  for (const e of d.entries) {
    const k = redactPathEntry(e)
    r.diffs.set(k, (r.diffs.get(k) ?? 0) + 1)
  }
}

export interface Report {
  routes: Array<Record<string, unknown>>
  summary: { routes: number; reached_min_samples: number; below_min_samples: string[]; with_differences: string[] }
}

export function buildReport(results: RouteResult[]): Report {
  const routes = results.map((r) => ({
    route: r.route,
    cached: r.cached,
    min_samples: r.minSamples,
    samples: r.samples,
    distinct_requests: r.distinctRequests,
    reached_min_samples: r.samples >= r.minSamples,
    equal: r.equal,
    different: r.different,
    status_mismatch: r.statusMismatch,
    errors: r.errors,
    no_sampler: r.noSampler,
    diffs: [...r.diffs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([entry, count]) => ({ entry, count })),
  }))
  return {
    routes,
    summary: {
      routes: results.length,
      reached_min_samples: results.filter((r) => r.samples >= r.minSamples).length,
      below_min_samples: results.filter((r) => r.samples < r.minSamples).map((r) => r.route),
      with_differences: results.filter((r) => r.different > 0).map((r) => r.route),
    },
  }
}

/** Tên route trong báo cáo luôn là mẫu `GET /đường/dẫn/:tham_số`, không bao giờ là URL đã thay id. */
const ROUTE_TEMPLATE = /^GET \/[A-Za-z0-9_\-/.:]*$/

/** Kiểm cuối trước khi ghi: mọi chuỗi trong báo cáo phải thuộc các dạng cho phép; trả danh sách vi phạm (rỗng = sạch). */
export function findLeaks(report: Report): string[] {
  const bad: string[] = []
  const segsOk = (route: string): boolean => route.slice(4).split('/').every((s) => s === '' || (!/^[0-9]+$/.test(s) && /^:?[A-Za-z0-9_\-.]+$/.test(s)))
  for (const r of report.routes) {
    const route = String(r.route)
    if (!ROUTE_TEMPLATE.test(route) || !segsOk(route)) bad.push('route')
    for (const p of r.no_sampler as string[]) if (!IDENT.test(p)) bad.push('no_sampler')
    for (const d of r.diffs as Array<{ entry: string }>) if (redactPathEntry(d.entry) !== d.entry) bad.push('diff')
  }
  for (const s of [...report.summary.below_min_samples, ...report.summary.with_differences]) if (!ROUTE_TEMPLATE.test(s)) bad.push('summary')
  return bad
}
