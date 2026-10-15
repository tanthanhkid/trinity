#!/usr/bin/env node
/**
 * `pnpm e2e:full` — MỘT LỆNH: seed → mọi project → cleanup (teardown chạy cả khi test đỏ) → in tóm tắt.
 * Chạy trong 1 tiến trình Playwright (đăng nhập 1 lần/tài khoản). Nếu tiến trình chết giữa chừng mà manifest còn mục
 * chưa dọn thì tự chạy lại project `cleanup`. Không in mật khẩu/token.
 *
 * Biến môi trường: xem e2e/README.md (E2E_*_EMAIL/PASSWORD, E2E_BROWSER_CHANNEL, E2E_WORKERS thấp trên máy yếu...).
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const webDir = path.join(here, '..')
const env = { ...process.env, E2E_ALLOW_WRITE: '1' }
const manifest = path.join(here, '.seed-manifest.json')
const residualFile = path.join(here, '.cleanup-residual.json')
const extra = process.argv.slice(2)

const started = Date.now()
const run = (args, phase) =>
  spawnSync('npx', ['playwright', 'test', ...args], { cwd: webDir, env: { ...env, ...(phase ? { E2E_PHASE: phase } : {}) }, stdio: 'inherit' })

// Pha 1 (read): seed + smoke/rbac-ui/rbac-api/design-* — chạy song song tối đa E2E_WORKERS.
// Pha 2 (flows): luồng GHI một worker, SAU pha 1 (có flow đổi công tắc tính năng nên không được song song với smoke;
//   và project đọc đỏ không được chặn flows — Playwright bỏ qua project phụ thuộc khi dependency có ca đỏ).
// Pha 3 (cleanup): LUÔN chạy, cả khi pha 1/2 đỏ hoặc chết.
fs.mkdirSync(path.join(webDir, 'test-results'), { recursive: true })
for (const f of ['read', 'flows']) fs.rmSync(path.join(webDir, 'test-results', `report-${f}.json`), { force: true })
const phases = []
phases.push(run(['--project=setup', '--project=seed', '--project=smoke', '--project=rbac-ui', '--project=rbac-api', '--project=design-mobile', '--project=design-tablet', '--project=design-desktop', ...extra], 'read').status)
phases.push(run(['--project=flows', ...extra], 'flows').status)
console.log('\n[e2e:full] Dọn dữ liệu thử (cleanup)')
const cleanup = run(['--project=cleanup'], 'cleanup')
let cleanupRerun = false
try {
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  if (m.entries?.length) {
    console.log('\n[e2e:full] Manifest còn mục chưa dọn → chạy lại cleanup')
    cleanupRerun = true
    run(['--project=cleanup'], 'cleanup')
  }
} catch { /* không có manifest = đã dọn sạch */ }
const seconds = Math.round((Date.now() - started) / 1000)

// ── Tóm tắt theo project ──
const stats = {}
const failures = []
function walk(suite) {
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests ?? []) {
      const p = t.projectName
      const s = (stats[p] ??= { passed: 0, failed: 0, skipped: 0, flaky: 0 })
      if (t.status === 'expected') s.passed++
      else if (t.status === 'skipped') s.skipped++
      else if (t.status === 'flaky') s.flaky++
      else { s.failed++; failures.push(`${p} › ${spec.title}`) }
    }
  }
  for (const c of suite.suites ?? []) walk(c)
}
for (const f of ['read', 'flows', 'cleanup']) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(webDir, 'test-results', `report-${f}.json`), 'utf8'))
    for (const s of j.suites ?? []) walk(s)
  } catch { console.log(`[e2e:full] Không đọc được test-results/report-${f}.json`) }
}

const pad = (v, n) => String(v).padEnd(n)
console.log('\n══════════ TÓM TẮT e2e:full ══════════')
console.log(pad('project', 16), pad('pass', 7), pad('fail', 7), pad('skip', 7), 'flaky')
const tot = { passed: 0, failed: 0, skipped: 0, flaky: 0 }
for (const [p, s] of Object.entries(stats)) {
  console.log(pad(p, 16), pad(s.passed, 7), pad(s.failed, 7), pad(s.skipped, 7), s.flaky)
  for (const k of Object.keys(tot)) tot[k] += s[k]
}
console.log(pad('TỔNG', 16), pad(tot.passed, 7), pad(tot.failed, 7), pad(tot.skipped, 7), tot.flaky)
console.log(`Thời gian: ${Math.floor(seconds / 60)} phút ${seconds % 60} giây${cleanupRerun ? ' (có chạy lại cleanup)' : ''}`)
if (failures.length) console.log('\nCa ĐỎ:\n' + failures.map((f) => '  - ' + f).join('\n'))
try {
  const r = JSON.parse(fs.readFileSync(residualFile, 'utf8'))
  console.log('\nResidual (xoá mềm — vận hành xoá hẳn):')
  for (const [t, ids] of Object.entries(r.byTable)) console.log(`  ${t}: ${ids.join(', ')}`)
  console.log(`  → chi tiết: ${path.relative(webDir, residualFile)}`)
} catch { console.log('\nKhông có residual.') }
console.log('\nBáo cáo HTML: playwright-report/<pha>/index.html — pha read | flows | cleanup (npx playwright show-report playwright-report/read)')
process.exit([...phases, cleanup.status].every((c) => c === 0) && !failures.length ? 0 : 1)
