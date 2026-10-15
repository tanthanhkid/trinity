'use client'

import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { logFrontendEvent } from '@/lib/fe-logger'

const RELOAD_GUARD_KEY = 'trinity_chunk_reload_at'
const RELOAD_GUARD_MS = 60 * 1000
const RELOAD_DELAY_MS = 2500

function isChunkScriptError(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLScriptElement)) return false
  return target.src.includes('/_next/static/chunks/')
}

function isChunkLoadRejection(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') return false
  const name = (reason as { name?: unknown }).name
  const message = (reason as { message?: unknown }).message
  if (name === 'ChunkLoadError') return true
  if (typeof message === 'string' && message.includes('Loading chunk')) return true
  return false
}

function shouldSkipReload(): boolean {
  try {
    const at = sessionStorage.getItem(RELOAD_GUARD_KEY)
    if (!at) return false
    return Date.now() - parseInt(at, 10) < RELOAD_GUARD_MS
  } catch {
    return false
  }
}

function markReload(): void {
  try {
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()))
  } catch {
    // sessionStorage có thể bị disable (private mode); reload vẫn chạy.
  }
}

export function ChunkErrorWatcher() {
  const triggered = useRef(false)

  useEffect(() => {
    function handle(reason: string): void {
      if (triggered.current) return
      triggered.current = true
      logFrontendEvent('chunk_load_failed', {
        level: 'warn',
        component: 'chunk-error-watcher',
        extra: { reason },
      })
      if (shouldSkipReload()) {
        toast.error('Có lỗi tải mã giao diện. Vui lòng tải lại trang (F5).', {
          duration: Infinity,
          action: {
            label: 'Tải lại',
            onClick: () => window.location.reload(),
          },
        })
        return
      }
      markReload()
      toast.warning('Phát hiện bản cập nhật, đang tải lại...', {
        description: 'Trang sẽ tự làm mới trong vài giây.',
        duration: RELOAD_DELAY_MS,
      })
      setTimeout(() => window.location.reload(), RELOAD_DELAY_MS)
    }

    function onError(e: ErrorEvent): void {
      if (isChunkScriptError(e.target)) handle('script_error')
    }
    function onRejection(e: PromiseRejectionEvent): void {
      if (isChunkLoadRejection(e.reason)) handle('chunk_load_error')
    }

    window.addEventListener('error', onError, true)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError, true)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  return null
}
