'use client'

import { useEffect } from 'react'
import { useAuthStore } from '@/store/auth'
import { getAccessToken } from '@/lib/token-storage'
import { performTokenRefresh } from '@/lib/api-client'
import { decodeJwtExpMs } from '@/lib/jwt-exp'

/**
 * Gia hạn access token CHỦ ĐỘNG ~90s TRƯỚC khi hết hạn (và khi quay lại tab).
 *
 * Vì sao cần: request gọi `fetch()` THÔ (không qua axios interceptor của
 * apiClient) KHÔNG có cơ chế refresh-on-401 + retry. Khi access token (TTL 15')
 * hết hạn giữa phiên, các request đó trả 401 "Token không hợp lệ hoặc đã hết
 * hạn". Giữ token luôn còn hiệu lực ở
 * 1 nơi (app-wide) sửa gốc cho MỌI đường gọi mà không phải đụng từng call-site.
 *
 * An toàn:
 * - `performTokenRefresh` dùng chung guard `isRefreshing`/`failedQueue` với
 *   interceptor → không refresh đồng thời (không race xoay refresh token).
 * - KHÔNG tự đăng xuất: thất bại chỉ ghi log; interceptor reactive vẫn là nơi
 *   quyết định đăng xuất khi refresh token thật sự hết hạn.
 * - Dep `isAuthed` là boolean → effect chỉ chạy lại khi đăng nhập/đăng xuất,
 *   KHÔNG chạy lại mỗi lần token đổi (tránh render storm / nhân đôi timer).
 */
const REFRESH_LEAD_MS = 90_000 // refresh khi còn ≤ 90s là hết hạn
const RECHECK_MS = 60_000 // nhịp kiểm tra lại sau khi vừa refresh / token chưa đọc được

export function TokenRefreshScheduler(): null {
  const isAuthed = useAuthStore((s) => !!s.accessToken)

  useEffect(() => {
    if (!isAuthed) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async (): Promise<void> => {
      if (cancelled) return
      const expMs = decodeJwtExpMs(getAccessToken())
      if (expMs == null) {
        // Token chưa đọc được / không decode được → kiểm tra lại sau, KHÔNG refresh mù.
        timer = setTimeout(tick, RECHECK_MS)
        return
      }
      const msLeft = expMs - Date.now()
      if (msLeft > REFRESH_LEAD_MS) {
        // Còn xa hạn → ngủ tới sát hạn rồi mới refresh.
        timer = setTimeout(tick, msLeft - REFRESH_LEAD_MS)
        return
      }
      try {
        await performTokenRefresh()
      } catch {
        // Nuốt lỗi: interceptor reactive xử lý đăng xuất khi refresh token thật hết hạn.
      }
      if (!cancelled) timer = setTimeout(tick, RECHECK_MS)
    }

    const onVisible = (): void => {
      // Tab nền bị throttle timer → khi quay lại, kiểm tra ngay (token có thể đã sát hạn).
      if (document.visibilityState !== 'visible' || cancelled) return
      if (timer) clearTimeout(timer)
      void tick()
    }

    void tick()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [isAuthed])

  return null
}
