#!/usr/bin/env node
/**
 * Dung lượng JS tải lần đầu của TỪNG route sau `next build` (Turbopack không còn in bảng này) + so với ngân sách.
 *
 *   node scripts/route-js-size.mjs            # in bảng, so với route-js-budget.json, vượt ⇒ exit 1
 *   node scripts/route-js-size.mjs --json     # in JSON (để so trước / sau)
 *   node scripts/route-js-size.mjs --write    # ghi lại ngân sách = số đo hiện tại + 5% (làm tròn lên 5 kB)
 *   node scripts/route-js-size.mjs --out      # đo bản xuất tĩnh `out/` (sau `pnpm build:export`) thay cho `.next`
 *                                             # (tự chọn khi chỉ có out/); cùng ngân sách, cùng cờ --json/--write
 *
 * Cách đo: mỗi trang có `.next/server/app/<route>/page_client-reference-manifest.js`; `entryJSFiles` liệt kê các chunk
 * mà HTML của trang nạp ngay (layout gốc, layout nhóm, error/not-found, chính trang). Cộng thêm `rootMainFiles` (runtime
 * React/Next) từ `build-manifest.json`. Chunk tải động (`next/dynamic`, `import()`) KHÔNG nằm trong danh sách — đúng thứ
 * lazy-load bớt được. Số liệu = gzip mức 9 (gần với cỡ truyền thật), đơn vị kB = 1000 byte.
 *   - `first_load_kb`: tổng mọi chunk route nạp lần đầu.
 *   - `page_kb`: phần RIÊNG của trang (bỏ các chunk layout dùng chung) — chỗ thay đổi của từng màn hiện rõ.
 *
 * Bản `out/`: không có manifest, nên đọc thẳng HTML của từng trang — mọi `<script src>` / `<link rel=preload as=script>` trỏ
 * `/_next/static/**.js` là chunk nạp ngay (cùng định nghĩa "tải lần đầu"). Route động là trang giữ chỗ `_` (`contacts/_.html`)
 * và được gọi bằng tên của ngân sách (`/contacts/[id]`) khi khớp. `page_kb` = chunk chỉ riêng trang đó dùng.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { gzipSync } from 'node:zlib'

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const nextDir = join(webDir, '.next')
const outDir = join(webDir, 'out')
const budgetFile = join(webDir, 'route-js-budget.json')
const args = new Set(process.argv.slice(2))

const hasNext = existsSync(join(nextDir, 'build-manifest.json'))
const hasOut = existsSync(join(outDir, 'index.html'))
const fromOut = args.has('--out') || (!hasNext && hasOut)
if (!fromOut && !hasNext) {
  console.error('Chưa có .next/build-manifest.json — chạy `next build` trước (hoặc `pnpm build:export` rồi dùng --out).')
  process.exit(2)
}
if (fromOut && !hasOut) {
  console.error('Chưa có out/ — chạy `pnpm build:export` trước.')
  process.exit(2)
}

const gzCache = new Map()
function gz(file) {
  if (!gzCache.has(file)) gzCache.set(file, gzipSync(readFileSync(join(fromOut ? outDir : nextDir, file)), { level: 9 }).length)
  return gzCache.get(file)
}
const kb = (bytes) => Math.round(bytes / 100) / 10

function* manifests(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) yield* manifests(p)
    else if (ent.name === 'page_client-reference-manifest.js') yield p
  }
}

/** '/(dashboard)/x/[objectKey]/page' ⇒ '/x/[objectKey]' (bỏ nhóm route trong ngoặc tròn). */
const routeOf = (key) =>
  key.replace(/\/page$/, '').split('/').filter((s) => s && !/^\(.*\)$/.test(s)).join('/').replace(/^/, '/')

/** Bản `out/`: route từ đường dẫn HTML; đoạn `_` (giữ chỗ) đổi về tên trong ngân sách nếu khớp (`/contacts/_` ⇒ `/contacts/[id]`). */
function rowsFromOut() {
  const budgetRoutes = existsSync(budgetFile) ? Object.keys(JSON.parse(readFileSync(budgetFile, 'utf8')).routes ?? {}) : []
  const byShape = new Map(budgetRoutes.map((r) => [r.replace(/\[[^\]]+\]/g, '_'), r]))
  const pages = []
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.name.endsWith('.html')) pages.push(p)
    }
  }
  walk(outDir)
  const chunksOf = (html) =>
    new Set([...html.matchAll(/["'(]\/(_next\/static\/[^"'()\s]+?\.js)(?=[?"'()\s])/g)].map((m) => m[1]))
  const perRoute = []
  for (const file of pages) {
    const rel = relative(outDir, file).split(sep).join('/').replace(/\.html$/, '')
    if (rel === '404' || rel.startsWith('_')) continue // 404, _not-found
    const shape = '/' + rel.replace(/\/index$/, '').replace(/^index$/, '')
    const route = byShape.get(shape) ?? shape
    perRoute.push({ route, chunks: chunksOf(readFileSync(file, 'utf8')) })
  }
  const usage = new Map()
  for (const { chunks } of perRoute) for (const c of chunks) usage.set(c, (usage.get(c) ?? 0) + 1)
  return perRoute.map(({ route, chunks }) => ({
    route,
    first_load_kb: kb([...chunks].reduce((sum, f) => sum + gz(f), 0)),
    page_kb: kb([...chunks].filter((f) => usage.get(f) === 1).reduce((sum, f) => sum + gz(f), 0)),
  }))
}

function rowsFromNext() {
  const { rootMainFiles = [] } = JSON.parse(readFileSync(join(nextDir, 'build-manifest.json'), 'utf8'))
  const rows = []
  for (const file of manifests(join(nextDir, 'server', 'app'))) {
    const sandbox = { self: {} }
    sandbox.globalThis = sandbox
    vm.runInNewContext(readFileSync(file, 'utf8'), sandbox)
    for (const [key, m] of Object.entries(sandbox.__RSC_MANIFEST ?? {})) {
      const route = routeOf(key)
      if (route.startsWith('/_')) continue // _not-found, _global-error
      const entries = m.entryJSFiles ?? {}
      const all = new Set(rootMainFiles)
      for (const files of Object.values(entries)) for (const f of files) all.add(f)
      const pageEntry = Object.keys(entries).find((e) => e.endsWith('/page'))
      const shared = new Set(rootMainFiles)
      for (const [e, files] of Object.entries(entries)) if (e !== pageEntry) for (const f of files) shared.add(f)
      const own = (entries[pageEntry] ?? []).filter((f) => !shared.has(f))
      rows.push({
        route,
        first_load_kb: kb([...all].reduce((s, f) => s + gz(f), 0)),
        page_kb: kb(own.reduce((s, f) => s + gz(f), 0)),
      })
    }
  }
  return rows
}

const rows = fromOut ? rowsFromOut() : rowsFromNext()
rows.sort((a, b) => b.first_load_kb - a.first_load_kb || a.route.localeCompare(b.route))

if (args.has('--json')) {
  console.log(JSON.stringify(rows, null, 2))
  process.exit(0)
}

if (args.has('--write')) {
  if (fromOut) {
    console.error('--write chỉ dùng với `.next` (ngân sách ghi theo tên route của `.next`); bỏ --out.')
    process.exit(2)
  }
  const up5 = (n) => Math.ceil((n * 1.05) / 5) * 5
  const budget = {
    $comment:
      'Ngân sách JS tải lần đầu (kB gzip) theo route — scripts/route-js-size.mjs. Tăng có chủ đích thì chạy lại với --write và ghi lý do trong PR.',
    default_first_load_kb: up5(Math.max(...rows.map((r) => r.first_load_kb))),
    routes: Object.fromEntries(rows.map((r) => [r.route, up5(r.first_load_kb)])),
  }
  writeFileSync(budgetFile, JSON.stringify(budget, null, 2) + '\n')
  console.log(`Đã ghi ${budgetFile} (${rows.length} route).`)
  process.exit(0)
}

const budget = existsSync(budgetFile) ? JSON.parse(readFileSync(budgetFile, 'utf8')) : { routes: {} }
const limitOf = (route) => budget.routes?.[route] ?? budget.default_first_load_kb ?? Infinity
const over = rows.filter((r) => r.first_load_kb > limitOf(r.route))

const lines = [
  '| Route | Tải lần đầu (kB gzip) | Riêng trang (kB) | Ngân sách (kB) |',
  '|---|---:|---:|---:|',
  ...rows.map((r) => {
    const lim = limitOf(r.route)
    const flag = r.first_load_kb > lim ? ' ❌' : ''
    return `| \`${r.route}\` | ${r.first_load_kb}${flag} | ${r.page_kb} | ${Number.isFinite(lim) ? lim : '—'} |`
  }),
]
console.log(lines.join('\n'))
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### JS theo route\n\n${lines.join('\n')}\n`)
}
if (over.length) {
  console.error(
    `\nVượt ngân sách: ${over.map((r) => `${r.route} ${r.first_load_kb} > ${limitOf(r.route)} kB`).join('; ')}.\n` +
      'Giảm JS (next/dynamic cho phần nặng, bỏ import thừa) hoặc — nếu tăng có chủ đích — chạy `node scripts/route-js-size.mjs --write` và ghi lý do trong PR.',
  )
  process.exit(1)
}
console.log(`\nMọi ${rows.length} route trong ngân sách.`)
