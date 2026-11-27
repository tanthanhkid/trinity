import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { config } from '../../lib/config.js'
import { computeCoverage, loadCalls, loadRoutes, type ClusterDef } from '../../lib/coverage.js'

/**
 * Báo cáo độ phủ route cụm `hr-attendance` (C14d), cùng cách đo với `99-coverage-auth-settings` (C14a): chạy CUỐI nên đọc lời gọi
 * của mọi file ca trước đó trong cùng lượt (chạy cả hồ sơ, không chạy lẻ file này). Ghi `<out>/coverage/default/hr-attendance.report.json`.
 */
const clusters = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../coverage-clusters.json'), 'utf8')) as Record<string, ClusterDef>

describe('độ phủ route: cụm nhân sự và chấm công', () => {
  it('mọi route đủ loại ca cần có (thành công, từ chối, đầu vào sai, không tồn tại) hoặc có miễn trừ ghi lý do', () => {
    const rows = computeCoverage(loadRoutes(), loadCalls(), clusters['hr-attendance'])
    const need = rows.reduce((n, r) => n + r.required.length, 0)
    const waived = rows.reduce((n, r) => n + Object.keys(r.waived).length, 0)
    const done = rows.reduce((n, r) => n + r.covered.length, 0)
    const dir = path.join(config.outDir, 'coverage', config.profile)
    fs.writeFileSync(path.join(dir, 'hr-attendance.report.json'), `${JSON.stringify({ routes: rows.length, categories_required: need, covered: done, waived, rows }, null, 2)}\n`)
    const gaps = rows.filter((r) => r.missing.length).map((r) => `${r.route}: thiếu ${r.missing.join(', ')}`)
    console.log(`[coverage hr-attendance] ${rows.length} route, ${done}/${need} loại ca phủ, ${waived} miễn trừ, ${gaps.length} route còn thiếu`)
    expect(gaps).toEqual([])
  })
})
