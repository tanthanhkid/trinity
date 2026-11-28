/* eslint-disable */
/**
 * Service Worker của Trinity (vòng 3 tốc độ). Mẫu này được `scripts/make-sw.mjs` điền mã build, danh sách precache
 * và danh sách trang sau `next build` rồi ghi ra `out/sw.js`. Rust phục vụ `/sw.js` với `Cache-Control: no-cache`.
 *
 * - `/_next/static/*` (tên có hash, bất biến): cache-first. Chunk của các màn chính được precache lúc cài.
 * - HTML (điều hướng) và payload RSC `.txt`: stale-while-revalidate — vẽ ngay bản đã lưu, tải bản mới ngầm cho lần sau.
 * - KHÔNG bao giờ đụng `/api`, `/notif-ws`, `/uploads`, `/docs`, `/.well-known`, `/health`... (đi thẳng mạng), và không cache
 *   phản hồi chuyển hướng/lỗi (người chưa đăng nhập bị chuyển về /login không bị kẹt trang cũ).
 * - Bản mới: skipWaiting + clients.claim, xoá mọi cache của bản cũ khi activate (không kẹt bản cũ).
 * - Tắt khẩn: tạo tệp `sw-kill` cạnh `out/` ⇒ Rust trả `/sw.js` dạng tự huỷ (xoá cache, huỷ đăng ký, tải lại tab).
 *   Tin nhắn `{type:'clear-pages'}` (gửi khi đăng xuất) xoá bộ nhớ HTML.
 */
const BUILD_ID = '__BUILD_ID__'
const PRECACHE = __PRECACHE__
const PAGES = __PAGES__
const STATIC = 'trinity-static-' + BUILD_ID
const PAGE_CACHE = 'trinity-pages-' + BUILD_ID
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
      const keep = new Set([STATIC, PAGE_CACHE])
      for (const k of await caches.keys()) if (k.startsWith('trinity-') && !keep.has(k)) await caches.delete(k)
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
  const hit = await cache.match(req)
  if (hit) return hit
  const res = await fetch(req)
  if (res.ok && res.type === 'basic') cache.put(req, res.clone())
  return res
}

/** Khoá HTML theo đường dẫn (bỏ query: trang tĩnh giống nhau). */
function pageKey(url) {
  return new Request(url.origin + url.pathname)
}

async function staleWhileRevalidate(event, req, key) {
  const cache = await caches.open(PAGE_CACHE)
  const cached = await cache.match(key)
  const network = fetch(req)
    .then((res) => {
      // Chỉ lưu trang 200 thật: không lưu chuyển hướng (opaqueredirect), 404, 5xx.
      if (res.status === 200 && res.type === 'basic') cache.put(key, res.clone())
      return res
    })
    .catch((err) => {
      if (cached) return cached
      throw err
    })
  if (cached) {
    event.waitUntil(network.catch(() => {}))
    return cached
  }
  return network
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
    event.respondWith(staleWhileRevalidate(event, req, pageKey(url)))
    return
  }
  // Payload RSC của điều hướng phía client (`/x/__next.*.txt`): cùng bản build với HTML ⇒ cùng cách.
  if (path.endsWith('.txt') && path.includes('/__next.')) {
    event.respondWith(staleWhileRevalidate(event, req, new Request(url.origin + path)))
  }
})
