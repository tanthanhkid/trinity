'use client'

import { useEffect, useRef } from 'react'
import { toast } from 'sonner'

const POLL_INTERVAL_MS = 5 * 60 * 1000
const HIDDEN_RELOAD_DELAY_MS = 60 * 1000

export function BuildIdWatcher() {
  const initialBuildId = useRef<string | null>(null)
  const notified = useRef(false)

  useEffect(() => {
    let cancelled = false
    let hiddenTimer: ReturnType<typeof setTimeout> | null = null

    async function fetchBuildId(): Promise<string | null> {
      try {
        const res = await fetch('/api/build-id', { cache: 'no-store' })
        if (!res.ok) return null
        const data = (await res.json()) as { buildId?: string }
        return data.buildId ?? null
      } catch {
        return null
      }
    }

    async function check() {
      if (cancelled || notified.current) return
      const id = await fetchBuildId()
      if (cancelled || !id || id === 'unknown') return
      if (initialBuildId.current === null) {
        initialBuildId.current = id
        return
      }
      if (id === initialBuildId.current) return
      notified.current = true
      toast.info('Có bản cập nhật mới', {
        description: 'Vui lòng tải lại trang để áp dụng các sửa lỗi.',
        duration: Infinity,
        action: {
          label: 'Tải lại',
          onClick: () => window.location.reload(),
        },
      })
      // Tab ẩn → tự reload sau một khoảng trễ.
      if (document.hidden) {
        hiddenTimer = setTimeout(
          () => window.location.reload(),
          HIDDEN_RELOAD_DELAY_MS,
        )
      }
    }

    check()
    const intervalId = setInterval(check, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(intervalId)
      if (hiddenTimer) clearTimeout(hiddenTimer)
    }
  }, [])

  return null
}
