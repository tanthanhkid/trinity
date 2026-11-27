#!/usr/bin/env node
/**
 * Kiểm bản xuất tĩnh sau `pnpm build:export` (tiêu chí W02a), không cần trình duyệt:
 *   node scripts/check-export.mjs
 *  1. Mọi trang trong src/app (bỏ `page.standalone.tsx`) mở được qua máy chủ tĩnh thử (serve-export.mjs), route động bằng giá trị thật;
 *  2. không tệp nào CÓ TRONG bản xuất còn `force-dynamic` (bỏ `*.standalone.*`, `route.ts`, `proxy.ts`: không vào bản xuất);
 *  3. `/privacy`, `/terms` có tên đơn vị ngay trong HTML khi máy chủ thử chèn giá trị; tên miền phụ cho `<meta name="store-slug">`;
 *  4. luật giữ chỗ: payload (`__next*.txt`) của route động cũng được trả.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { createServer, webDir } from './serve-export.mjs'
import { buildRules } from './export-static.mjs'

const outDir = join(webDir, 'out')
const appDir = join(webDir, 'src', 'app')
if (!existsSync(join(outDir, 'index.html'))) {
  console.error('Chưa có out/ — chạy `pnpm build:export` trước.')
  process.exit(2)
}

function* walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) yield* walk(p)
    else yield p
  }
}

const SAMPLE = { id: '123', objectKey: 'khach', viewKey: 'kanban1', token: 'TOKEN-xyz-1', slug: 'cua-hang-abc' }
const pages = []
const forceDynamic = []
for (const f of walk(appDir)) {
  const rel = relative(appDir, f).split(sep).join('/')
  const base = rel.split('/').pop()
  if (/\.(test|spec)\./.test(base) || rel.includes('/__tests__/')) continue
  const inExport = /\.tsx$/.test(base) && !/\.standalone\.tsx$/.test(base) // pageExtensions của bản xuất: export.tsx, tsx
  if (!inExport) continue
  if (/^export const dynamic\s*=\s*['"]force-dynamic['"]/m.test(readFileSync(f, 'utf8'))) forceDynamic.push(rel)
  if (/^page(\.export)?\.tsx$/.test(base)) {
    const segs = rel.split('/').slice(0, -1).filter((s) => !/^\(.*\)$/.test(s))
    pages.push('/' + segs.map((s) => (s.startsWith('[') ? SAMPLE[s.slice(1, -1)] ?? '1' : s)).join('/'))
  }
}

const server = createServer({
  outDir,
  storeDomain: 'store.test',
  legal: { contact_email: 'lienhe@example.com', company_name: 'Công ty Thử Nghiệm', company_name_en: null, company_tax_id: null, company_address: null, company_phone: null },
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const fails = []
const get = (path, headers) => fetch(base + path, { headers, redirect: 'manual' })

for (const p of pages) {
  const res = await get(p)
  if (res.status !== 200 || !(res.headers.get('content-type') ?? '').includes('text/html')) fails.push(`${p} → ${res.status}`)
}
for (const p of ['/privacy', '/terms']) {
  const html = await (await get(p)).text()
  if (!html.includes('Công ty Thử Nghiệm')) fails.push(`${p}: HTML không có tên đơn vị`)
  if (html.includes('__LEGAL_')) fails.push(`${p}: còn chuỗi giữ chỗ chưa thay`)
}
{
  const html = await (await get('/', { host: 'cua-hang-abc.store.test' })).text()
  if (!html.includes('name="store-slug" content="cua-hang-abc"')) fails.push('tên miền phụ: thiếu <meta store-slug>')
}
// payload của route động: lấy tên tệp thật trong out/ rồi hỏi bằng giá trị thật
for (const rule of buildRules(outDir)) {
  const dir = join(outDir, ...rule.segments)
  if (!existsSync(dir)) continue
  const payload = readdirSync(dir).find((n) => n.startsWith('__next') && n.endsWith('.txt'))
  if (!payload) continue
  const real = rule.segments.map((s, i) => (s === '_' ? ['123', 'khach', 'kanban1', 'TOKEN-xyz-1'][i % 4] : s))
  const res = await get(`/${real.join('/')}/${payload}`)
  if (res.status !== 200) fails.push(`payload ${rule.pattern}/${payload} → ${res.status}`)
}
server.close()

console.log(`${pages.length} trang kiểm, ${buildRules(outDir).length} luật giữ chỗ.`)
if (forceDynamic.length) fails.push(`còn force-dynamic trong bản xuất: ${forceDynamic.join(', ')}`)
if (fails.length) {
  console.error(fails.map((f) => `✗ ${f}`).join('\n'))
  process.exit(1)
}
console.log('Bản xuất tĩnh đạt.')
