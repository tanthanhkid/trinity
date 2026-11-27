#!/usr/bin/env node
/**
 * Máy chủ tĩnh THỬ cho `out/` (đóng vai Rust của K18; không dùng ngoài kiểm thử).
 *
 *   node scripts/serve-export.mjs [--port 5055] [--store-domain store.test]
 *
 *  - luật trang giữ chỗ cho 8 route động (scripts/export-static.mjs, sinh từ `out/`);
 *  - `<slug>.<store-domain>` + `/` ⇒ trang `s/_` có `<meta name="store-slug">`;
 *  - `/privacy`, `/terms` chèn giá trị pháp lý từ `LEGAL_*` trong môi trường (tên đơn vị hiện ngay trong HTML);
 *  - `/api/v1/site-config` trả `{ legal }` từ cùng biến, để thử đường lùi của trang pháp lý;
 *  - `API_PROXY_URL=http://127.0.0.1:4000`: `/api/v1`, `/uploads`, `/.well-known` chuyển nguyên sang monolith (CI e2e; Rust làm việc này ở bản thật).
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pipeline } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { buildRules, resolvePath, mimeOf, injectHtml, legalFromEnv } from './export-static.mjs'

/** Chuyển nguyên request sang `target` (chỉ cho CI/thử nghiệm, không thay Rust). */
function proxyTo(target, req, res) {
  const t = new URL(target)
  const up = http.request(
    { host: t.hostname, port: t.port, path: req.url, method: req.method, headers: { ...req.headers, host: t.host } },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      pipeline(r, res, () => {})
    },
  )
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
    res.end('bad gateway')
  })
  pipeline(req, up, () => {})
}

export const webDir = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Tạo máy chủ (chưa listen). `legal` mặc định đọc từ env. */
export function createServer({ outDir = join(webDir, 'out'), storeDomain = 'store.test', legal = legalFromEnv(), apiProxy = process.env.API_PROXY_URL } = {}) {
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
    if (apiProxy && /^\/(api\/v1|uploads|\.well-known)(\/|$)/.test(pathname) && pathname !== '/api/v1/site-config') return proxyTo(apiProxy, req, res)
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
