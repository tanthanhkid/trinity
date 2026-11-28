'use client'

import { useEffect } from 'react'

/**
 * Đăng ký Service Worker (`/sw.js`, sinh lúc build — xem `scripts/make-sw.mjs`). Chỉ bản production, sau khi trang đã
 * tải xong và rảnh để việc cài/precache không tranh băng thông với lần vẽ đầu. Máy chủ trả bản tự huỷ khi có tệp
 * `sw-kill` ⇒ lần cập nhật kế tiếp tự gỡ Service Worker.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const register = () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {
        /* không đăng ký được (chế độ riêng tư, chặn) ⇒ web chạy như cũ */
      })
    }
    const later = () => {
      const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
      if (w.requestIdleCallback) w.requestIdleCallback(register, { timeout: 4000 })
      else setTimeout(register, 2000)
    }
    if (document.readyState === 'complete') later()
    else {
      window.addEventListener('load', later, { once: true })
      return () => window.removeEventListener('load', later)
    }
  }, [])
  return null
}
