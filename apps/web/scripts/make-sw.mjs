/**
 * Sinh `out/sw.js` từ `sw-template.js` sau `next build` (gọi từ build-export.mjs).
 * - `__BUILD_ID__`: tên thư mục build của Next dưới `_next/static/` (đổi mỗi lần build ⇒ trình duyệt thấy sw.js mới);
 *   không có thì băm danh sách precache.
 * - `__PRECACHE__`: mọi JS/CSS mà HTML các màn chính nạp ngay (hợp của các route) — chunk bất biến, thường đã nằm trong
 *   cache HTTP nên cài đặt gần như không tốn thêm mạng.
 * - `__PAGES__`: đường dẫn HTML của các màn chính (vỏ trang).
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Các màn chính (route Next, không có đuôi .html). `/login` luôn có để người chưa đăng nhập cũng nhanh. */
export const MAIN_PAGES = ['/login', '/dashboard', '/contacts', '/inbox', '/kanban', '/reports', '/products', '/connections']

export function assetsOfHtml(html) {
  const out = new Set()
  const re = /(?:src|href)="(\/_next\/static\/[^"?]+\.(?:js|css))"/g
  let m
  while ((m = re.exec(html))) out.add(m[1])
  return out
}

export function buildIdOf(outDir, precache) {
  const base = join(outDir, '_next', 'static')
  if (existsSync(base)) {
    for (const n of readdirSync(base)) {
      if (n === 'chunks' || n === 'media') continue
      if (statSync(join(base, n)).isDirectory()) return n
    }
  }
  return createHash('sha1').update(precache.join('\n')).digest('hex').slice(0, 16)
}

export function writeServiceWorker(outDir) {
  const pre = new Set()
  const pages = []
  for (const p of MAIN_PAGES) {
    const f = join(outDir, p.slice(1) + '.html')
    if (!existsSync(f)) continue
    pages.push(p)
    for (const a of assetsOfHtml(readFileSync(f, 'utf8'))) pre.add(a)
  }
  const precache = [...pre].sort()
  const id = buildIdOf(outDir, precache)
  const tpl = readFileSync(join(here, 'sw-template.js'), 'utf8')
  const js = tpl
    .replace("'__BUILD_ID__'", () => JSON.stringify(id))
    .replace('__PRECACHE__', () => JSON.stringify(precache))
    .replace('__PAGES__', () => JSON.stringify(pages))
  writeFileSync(join(outDir, 'sw.js'), js)
  return { id, precache: precache.length, pages: pages.length }
}
