'use client'

import { useEffect } from 'react'

/** Trang không đăng ký Service Worker. */
const NO_SW_PATH = /^\/(s|oauth|privacy|terms|invite|register)(\/|$)/

/**
 * Đăng ký Service Worker (`/sw.js`, sinh lúc build — xem `scripts/make-sw.mjs`). Chỉ bản production, sau khi trang đã
 * tải xong và rảnh để việc cài/precache không tranh băng thông với lần vẽ đầu. Máy chủ trả bản tự huỷ khi có tệp
 * `sw-kill` ⇒ lần cập nhật kế tiếp tự gỡ Service Worker.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    // Chỉ route của ứng dụng: không đăng ký ở trang công khai/cửa hàng/OAuth, cũng không ở host cửa hàng (meta store-slug).
    if (NO_SW_PATH.test(window.location.pathname) || document.querySelector('meta[name="store-slug"]')) return
    const register = async () => {
      // Đã có đăng ký ⇒ kiểm máy chủ có đang tắt khẩn (trả bản tự huỷ) không; chưa có thì khỏi tải sw.js thêm một lần.
      try {
        const regs = await navigator.serviceWorker.getRegistrations()
        if (regs.length > 0) {
          const body = await (await fetch('/sw.js', { cache: 'no-store' })).text()
          if (body.includes('registration.unregister')) {
            for (const r of regs) await r.unregister()
            return
          }
        }
      } catch {
        /* không kiểm được ⇒ cứ đăng ký, SW tự xử lý */
      }
      navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {
        /* không đăng ký được (chế độ riêng tư, chặn) ⇒ web chạy như cũ */
      })
    }
    const later = () => {
      const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
      if (w.requestIdleCallback) w.requestIdleCallback(() => void register(), { timeout: 4000 })
      else setTimeout(() => void register(), 2000)
    }
    if (document.readyState === 'complete') later()
    else {
      window.addEventListener('load', later, { once: true })
      return () => window.removeEventListener('load', later)
    }
  }, [])
  return null
}
