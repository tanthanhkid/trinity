#!/usr/bin/env node
/**
 * `pnpm build:export` — xuất tĩnh ra `apps/web/out/` (song song với `next build` thường, không đụng `.next` của bản standalone).
 * Chọn cấu hình bằng biến `NEXT_OUTPUT=export` (next.config.ts) nên chạy được cả trên Windows (không cần `cross-env`).
 * Xong ghi `out/export-rules.json`: bảng luật "mẫu đường dẫn → trang giữ chỗ" SINH từ kết quả build (không viết tay),
 * để máy chủ tĩnh thử (serve-export.mjs) và K18 (Rust) dùng chung.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRules } from './export-static.mjs'

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(webDir, 'out')

rmSync(outDir, { recursive: true, force: true })
const bin = process.platform === 'win32' ? 'next.cmd' : 'next'
const r = spawnSync(join(webDir, 'node_modules', '.bin', bin), ['build'], {
  cwd: webDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, NEXT_OUTPUT: 'export' },
})
if (r.status !== 0) process.exit(r.status ?? 1)
if (!existsSync(outDir)) {
  console.error('`next build` thành công nhưng không thấy out/ — kiểm tra NEXT_OUTPUT=export trong next.config.ts.')
  process.exit(1)
}
const rules = buildRules(outDir)
writeFileSync(join(outDir, 'export-rules.json'), JSON.stringify(rules, null, 2) + '\n')
console.log(`Đã xuất out/ (${rules.length} luật trang giữ chỗ: ${rules.map((x) => x.pattern).join(', ')}).`)
