/* eslint-disable */
/**
 * Service Worker của Trinity (vòng 3 tốc độ). Mẫu này được `scripts/make-sw.mjs` điền mã build, danh sách precache
 * và danh sách trang sau `next build` rồi ghi ra `out/sw.js`. Rust phục vụ `/sw.js` với `Cache-Control: no-cache`.
 *
 * - `/_next/static/*` (tên có hash, bất biến): cache-first. Chunk của các màn chính được precache lúc cài.
 * - HTML (điều hướng) và payload RSC `.txt`: mạng trước với hạn ngắn (~1,5 giây) rồi mới tới bản đã lưu — sau deploy luôn
 *   nhận HTML mới (không trỏ tới chunk đã mất); mạng chậm/đứt thì dùng bản đã lưu. Tối đa 100 mục.
 * - KHÔNG bao giờ đụng `/api`, `/notif-ws`, `/uploads`, `/docs`, `/.well-known`, `/health`... (đi thẳng mạng), và không cache
 *   phản hồi chuyển hướng/lỗi (người chưa đăng nhập bị chuyển về /login không bị kẹt trang cũ).
 * - Bản mới: skipWaiting + clients.claim. Giữ cache chunk của bản LIỀN TRƯỚC (tab cũ còn cần chunk tải lười), chỉ xoá
 *   các bản cũ hơn; HTML chỉ dùng cache của bản hiện tại.
 * - Tắt khẩn: đặt `TRINITY_SW_KILL=1` hoặc tạo tệp `sw-kill` CẠNH `out/` (không trong đó: build xoá `out/`) ⇒ Rust trả
 *   `/sw.js` dạng tự huỷ (xoá cache, huỷ đăng ký, tải lại tab).
 *   Tin nhắn `{type:'clear-pages'}` (gửi khi đăng xuất) xoá bộ nhớ HTML.
 */
const BUILD_ID = '__BUILD_ID__'
const PRECACHE = __PRECACHE__
const PAGES = __PAGES__
const STATIC = 'trinity-static-' + BUILD_ID
const PAGE_CACHE = 'trinity-pages-' + BUILD_ID
const META = 'trinity-meta'
const NAV_TIMEOUT_MS = 1500
const PAGE_MAX = 100
const BYPASS = ['/api', '/notif-ws', '/uploads', '/docs', '/.well-known', '/health', '/ready', '/live', '/internal', '/metrics', '/sw.js', '/sw-kill', '/oauth', '/assistant', '/s']

function bypass(path) {
  for (const b of BYPASS) if (path === b || path.startsWith(b + '/')) return true
  return false
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC)
      // Từng tệp một, lỗi tệp nào bỏ tệp đó: precache chỉ là tối ưu, không được làm hỏng việc cài đặt.
      await Promise.allSettled(
        PRECACHE.map(async (u) => {
          if (await cache.match(u)) return
          const res = await fetch(u, { credentials: 'same-origin' })
          if (res.ok) await cache.put(u, res)
        }),
      )
      // Vỏ HTML các màn chính (chỉ khi đang có phiên: chưa đăng nhập thì máy chủ chuyển hướng ⇒ bỏ qua, không lưu).
      const pages = await caches.open(PAGE_CACHE)
      await Promise.allSettled(
        PAGES.map(async (u) => {
          const res = await fetch(u, { credentials: 'same-origin', redirect: 'manual' })
          if (res.status === 200 && res.type === 'basic') await pages.put(u, res)
        }),
      )
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Lịch sử build đã kích hoạt (cũ → mới): giữ bản hiện tại + bản liền trước.
      const meta = await caches.open(META)
      let hist = []
      try {
        const r = await meta.match('history')
        if (r) hist = await r.json()
      } catch (e) {
        hist = []
      }
      hist = hist.filter((x) => x !== BUILD_ID).concat(BUILD_ID).slice(-2)
      await meta.put('history', new Response(JSON.stringify(hist)))
      const keepStatic = new Set(hist.map((id) => 'trinity-static-' + id))
      const keepPages = new Set([PAGE_CACHE])
      for (const k of await caches.keys()) {
        if (k === META) continue
        if (k.startsWith('trinity-static-') && !keepStatic.has(k)) await caches.delete(k)
        else if (k.startsWith('trinity-pages-') && !keepPages.has(k)) await caches.delete(k)
      }
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  const d = event.data
  if (d && d.type === 'clear-pages') event.waitUntil(caches.delete(PAGE_CACHE))
  if (d && d.type === 'skip-waiting') self.skipWaiting()
})

async function cacheFirst(req) {
  const cache = await caches.open(STATIC)
  const hit = (await cache.match(req)) || (await caches.match(req))
  if (hit) return hit
  const res = await fetch(req)
  if (res.ok && res.type === 'basic') cache.put(req, res.clone())
  return res
}

/** Khoá HTML theo đường dẫn (bỏ query: trang tĩnh giống nhau). */
function pageKey(url) {
  return new Request(url.origin + url.pathname)
}

async function trimPages(cache) {
  const keys = await cache.keys()
  for (let i = 0; i < keys.length - PAGE_MAX; i++) await cache.delete(keys[i])
}

/** Mạng trước (hạn NAV_TIMEOUT_MS) rồi tới bản đã lưu; lưu bản mới khi mạng trả 200 thật. */
async function networkFirst(event, req, key) {
  const cache = await caches.open(PAGE_CACHE)
  const network = fetch(req).then((res) => {
    // Chỉ lưu trang 200 thật: không lưu chuyển hướng (opaqueredirect), 404, 5xx.
    if (res.status === 200 && res.type === 'basic') {
      const copy = res.clone()
      event.waitUntil(cache.put(key, copy).then(() => trimPages(cache)).catch(() => {}))
    }
    return res
  })
  const cached = await cache.match(key)
  if (!cached) return network
  const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), NAV_TIMEOUT_MS))
  // Mạng lỗi ⇒ bản đã lưu; mạng quá chậm ⇒ bản đã lưu (mạng vẫn chạy ngầm để làm mới cache).
  const safe = network.catch(() => cached)
  event.waitUntil(network.catch(() => {}))
  return Promise.race([safe, timeout])
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET' || req.headers.has('range')) return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  const path = url.pathname
  if (bypass(path)) return
  if (path.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(req))
    return
  }
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(event, req, pageKey(url)))
    return
  }
  // Payload RSC của điều hướng phía client (`/x/__next.*.txt`): cùng bản build với HTML ⇒ cùng cách.
  if (path.endsWith('.txt') && path.includes('/__next.')) {
    event.respondWith(networkFirst(event, req, new Request(url.origin + path)))
  }
})
