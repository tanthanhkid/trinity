import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'
const OUT = path.resolve('out'); const log = []
const RULES = [ // [regex, placeholder]
  [/^\/a\/contacts\/[^/]+/, '/a/contacts/_'],
  [/^\/a\/x\/[^/]+\/v\/[^/]+/, '/a/x/_/v/_'],
  [/^\/a\/s\/[^/]+/, '/a/s/_'],
  [/^\/a\/invite\/[^/]+/, '/a/invite/_'],
]
const MIME = { '.html':'text/html', '.txt':'text/x-component', '.js':'application/javascript', '.css':'text/css' }
function resolve(p, host) {
  const sub = host.split(':')[0].match(/^([a-z0-9-]+)\.store\.test$/)
  if (sub && (p === '/' || p.startsWith('/__next') || p === '/index.txt')) { // tên miền phụ: gốc = trang cửa hàng
    return { file: p === '/' ? '/a/s/_.html' : p === '/index.txt' ? '/a/s/_.txt' : p, slug: sub[1] }
  }
  for (const [re, ph] of RULES) { const m = p.match(re); if (m) return { file: ph + p.slice(m[0].length) || ph } }
  return { file: p }
}
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let p = decodeURIComponent(u.pathname); log.push(req.method + ' ' + req.url)
  if (p === '/__log') { res.end(JSON.stringify(log)); log.length = 0; return }
  let { file, slug } = resolve(p, req.headers.host || '')
  // chuẩn hoá: các đoạn thật trong đường dẫn payload (vd /a/contacts/123/__next...) đã được thay ở trên
  let cands = [file, file + '.html', file + '/index.html']
  for (const c of cands) { const fp = path.join(OUT, c); if (fp.startsWith(OUT) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      let body = fs.readFileSync(fp); if (fp.endsWith('.html')) { let s = body.toString(); s = s.replace('__STORE_SLUG__', slug || ''); body = Buffer.from(s) }
      res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream' }); return res.end(body) } }
  res.writeHead(404); res.end('404')
}).listen(+process.env.PORT || 5055)
