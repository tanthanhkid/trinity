import * as fs from 'node:fs'
import * as path from 'node:path'
import { expect } from 'vitest'
import { loadRoutes, type ClusterDef, type RouteRow } from './coverage.js'

/** Dùng chung cho ca sinh từ `routes.json` theo cụm (C14a, C14c): lọc route của cụm, điền tham số đường dẫn, quét và gom lỗi. */
export function clusterRoutes(name: string): RouteRow[] {
  const clusters = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../coverage-clusters.json'), 'utf8')) as Record<string, ClusterDef>
  const def = clusters[name]
  if (!def) throw new Error(`Không có cụm "${name}" trong coverage-clusters.json (có: ${Object.keys(clusters).join(', ')})`)
  return loadRoutes().filter((r) => def.controllers.includes(r.controller) && !r.deprecated)
}

export const hasBody = (r: RouteRow): boolean => ['POST', 'PUT', 'PATCH'].includes(r.method)
export const asKey = (r: RouteRow): string => `${r.method} ${r.path.replace('/api/v1', '')}`

/** Điền `:tham-số`: id số dùng `id`, tham số chữ dùng `text` (hoặc giá trị riêng theo tên). */
export function fillPath(r: RouteRow, id: string, text: string, named: Record<string, string> = {}): string {
  return r.path.replace(/:(\w+)/g, (_m, n: string) => named[n] ?? (n === 'id' ? id : text))
}

export async function sweep(list: RouteRow[], expected: number[], send: (r: RouteRow) => Promise<{ status: number }>): Promise<void> {
  const bad: string[] = []
  for (const r of list) {
    const res = await send(r)
    if (!expected.includes(res.status)) bad.push(`${asKey(r)} → ${res.status}`)
  }
  expect(bad, `mong đợi ${expected.join('/')}`).toEqual([])
}
