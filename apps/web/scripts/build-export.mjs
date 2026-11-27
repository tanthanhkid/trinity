#!/usr/bin/env node
/**
 * `pnpm build` (cũng là `pnpm build:export`) — xuất tĩnh ra `apps/web/out/`; `output: 'export'` đặt cố định ở next.config.ts (W02b).
 * Xong ghi `out/export-rules.json`: bảng luật "mẫu đường dẫn → trang giữ chỗ" SINH từ kết quả build (không viết tay),
 * để máy chủ tĩnh thử (serve-export.mjs) và K18 (Rust) dùng chung.
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRules } from './export-static.mjs'

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(webDir, 'out')
// `distDir` riêng (.next-export) nên Next ghi bản xuất ở đó, không phải `out/`; chép sang `out/` cho các script phía sau.
const distDir = join(webDir, '.next-export')

rmSync(outDir, { recursive: true, force: true })
rmSync(distDir, { recursive: true, force: true })
const bin = process.platform === 'win32' ? 'next.cmd' : 'next'
const r = spawnSync(join(webDir, 'node_modules', '.bin', bin), ['build'], {
  cwd: webDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (r.status !== 0) process.exit(r.status ?? 1)
if (existsSync(distDir) && !existsSync(outDir)) cpSync(distDir, outDir, { recursive: true })
if (!existsSync(outDir)) {
  console.error('`next build` thành công nhưng không thấy out/ — kiểm tra output: export trong next.config.ts.')
  process.exit(1)
}
const rules = buildRules(outDir)
writeFileSync(join(outDir, 'export-rules.json'), JSON.stringify(rules, null, 2) + '\n')
console.log(`Đã xuất out/ (${rules.length} luật trang giữ chỗ: ${rules.map((x) => x.pattern).join(', ')}).`)
