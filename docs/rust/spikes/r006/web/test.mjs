// Chạy: PORT=5066 máy chủ spike; node test.mjs. Client = socket.io-client đúng bản web khoá (4.8.3), cùng tuỳ chọn như notification-socket.tsx.
import { io } from 'socket.io-client'
import jwt from 'jsonwebtoken'
import http from 'node:http'
import { chromium } from 'playwright-core'
const BASE = 'http://127.0.0.1:5066', SECRET = 'spike-secret'
const tok = (sub, cid) => jwt.sign({ sub, ...(cid ? { cid } : {}) }, SECRET, { expiresIn: 600 })
const push = (user, cid) => fetch(BASE + '/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user, cid }) })
const out = {}
function client(token) {
  const ev = []
  const s = io(BASE + '/notifications/ws', { path: '/notif-ws', auth: (cb) => cb({ token }), transports: ['websocket'], reconnection: false })
  s.on('notification:new', (p) => ev.push(['new', p.event_type])); s.on('notification:count', (p) => ev.push(['count', p.count]))
  s.on('connect_error', (e) => ev.push(['connect_error', e.message])); s.on('disconnect', (r) => ev.push(['disconnect', r]))
  return { s, ev }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
// 1) node: JWT hợp lệ, vào room, nhận 2 sự kiện; user khác / công ty khác không nhận
const a = client(tok(7)), b = client(tok(8)), c = client(tok(7, 2)), bad = client('xxx'), none = client('')
await wait(600); await push(7); await wait(400)
out.node_hop_le = [...a.ev]; out.node_user_khac = [...b.ev]; out.node_cong_ty_khac = [...c.ev]; out.token_sai = [...bad.ev]; out.khong_token = [...none.ev]
await push(7, 2); await wait(300); out.cong_ty2_nhan = [...c.ev]
for (const x of [a, b, c, bad, none]) x.s.close()
// 2) Chrome và (nếu có) WebKit: trang tĩnh khác origin (CORS) nạp bản min của socket.io-client
const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(`<script src="/io.js"></script>`) })
const js = (await import('node:fs')).readFileSync(new URL('./node_modules/socket.io-client/dist/socket.io.min.js', import.meta.url))
srv.removeAllListeners('request'); srv.on('request', (q, r) => q.url === '/io.js' ? (r.setHeader('content-type', 'text/javascript'), r.end(js)) : (r.setHeader('content-type', 'text/html'), r.end('<html><body>x<script src="/io.js"></script></body></html>')))
await new Promise((r) => srv.listen(5067, r))
async function browser(name, launcher, opts) {
  let br; try { br = await launcher.launch(opts) } catch (e) { out[name] = 'không chạy được: ' + e.message.split('\n')[0]; return }
  const pg = await br.newPage(); await pg.goto('http://localhost:5067/')
  const got = await pg.evaluate(async ([base, token]) => {
    const ev = []; const s = window.io(base + '/notifications/ws', { path: '/notif-ws', auth: (cb) => cb({ token }), transports: ['websocket'], reconnection: false })
    s.on('notification:new', (p) => ev.push('new:' + p.event_type)); s.on('notification:count', (p) => ev.push('count:' + p.count)); s.on('connect_error', (e) => ev.push('connect_error:' + e.message))
    await new Promise((r) => s.on('connect', r)); await fetch(base + '/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 9 }) })
    await new Promise((r) => setTimeout(r, 600)); return ev
  }, [BASE, tok(9)]).catch((e) => 'lỗi: ' + e.message.split('\n')[0])
  out[name] = got; await br.close()
}
await browser('chrome', chromium, { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
try { const { webkit } = await import('playwright-core'); await browser('webkit', webkit, {}) } catch (e) { out.webkit = String(e) }
srv.close(); console.log(JSON.stringify(out, null, 1))
