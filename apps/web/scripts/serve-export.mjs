#!/usr/bin/env node
/**
 * Máy chủ tĩnh THỬ cho `out/` (đóng vai Rust của K18; không dùng ngoài kiểm thử).
 *
 *   node scripts/serve-export.mjs [--port 5055] [--store-domain store.test]
 *
 *  - luật trang giữ chỗ cho 8 route động (scripts/export-static.mjs, sinh từ `out/`);
 *  - `<slug>.<store-domain>` + `/` ⇒ trang `s/_` có `<meta name="store-slug">`;
 *  - `/privacy`, `/terms` chèn giá trị pháp lý từ `LEGAL_*` trong môi trường (tên đơn vị hiện ngay trong HTML);
 *  - `/api/v1/site-config` trả `{ legal }` từ cùng biến, để thử đường lùi của trang pháp lý.
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRules, resolvePath, mimeOf, injectHtml, legalFromEnv } from './export-static.mjs'

export const webDir = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Tạo máy chủ (chưa listen). `legal` mặc định đọc từ env. */
export function createServer({ outDir = join(webDir, 'out'), storeDomain = 'store.test', legal = legalFromEnv() } = {}) {
  const rules = buildRules(outDir)
  const storeHost = new RegExp(`^([a-z0-9-]+)\\.${storeDomain.replace(/\./g, '\\.')}$`)
  const LEGAL_PATHS = new Set(['/privacy', '/terms'])
  const send = (res, status, type, body) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(body)
  }
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    let pathname
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      return send(res, 400, 'text/plain', 'bad path')
    }
    if (pathname === '/api/v1/site-config') return send(res, 200, 'application/json', JSON.stringify({ legal }))
    const sub = (req.headers.host ?? '').split(':')[0].match(storeHost)
    let slug
    let lookup = pathname
    if (sub && (pathname === '/' || pathname === '/index.txt' || pathname.startsWith('/__next'))) {
      slug = sub[1]
      lookup = pathname === '/' ? '/s/_' : pathname === '/index.txt' ? '/s/_.txt' : `/s/_${pathname}`
    }
    const hit = resolvePath(outDir, rules, lookup)
    if (!hit) {
      const nf = join(outDir, '404.html')
      return send(res, 404, 'text/html; charset=utf-8', readFileSync(nf))
    }
    const type = mimeOf(hit.file)
    if (hit.file.endsWith('.html')) {
      const html = injectHtml(readFileSync(hit.file, 'utf8'), { slug, legal: LEGAL_PATHS.has(pathname) ? legal : undefined })
      return send(res, 200, type, req.method === 'HEAD' ? '' : html)
    }
    send(res, 200, type, req.method === 'HEAD' ? '' : readFileSync(hit.file))
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (k, d) => {
    const i = process.argv.indexOf(k)
    return i > 0 ? process.argv[i + 1] : d
  }
  const port = Number(arg('--port', process.env.PORT ?? 5055))
  createServer({ storeDomain: arg('--store-domain', 'store.test') }).listen(port, '127.0.0.1', () =>
    console.log(`Máy chủ tĩnh thử: http://127.0.0.1:${port} (thư mục out/)`),
  )
}
