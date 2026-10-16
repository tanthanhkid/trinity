'use client'

import { useEffect } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { logFrontendError } from '@/lib/fe-logger'
import { reportClientError } from '@/lib/monitoring'

function isChunkLoadError(error: Error): boolean {
  return /loading chunk|failed to load chunk|dynamically imported module/i.test(error.message)
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    if (isChunkLoadError(error)) {
      const reloaded = sessionStorage.getItem('chunk-reload')
      if (!reloaded) {
        sessionStorage.setItem('chunk-reload', '1')
        window.location.reload()
        return
      }
      sessionStorage.removeItem('chunk-reload')
    }
    reportClientError(error)
    logFrontendError(error, { component: 'error-boundary-root', extra: { digest: error.digest } })
  }, [error])

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md space-y-5 rounded-[var(--radius)] border border-[var(--border)] bg-card p-8 text-center shadow-[var(--shadow-card)]">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-[var(--muted)] text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-7 w-7" aria-hidden />
        </div>
        <div className="space-y-2">
          <h2 className="text-[17px] font-semibold text-foreground">Có lỗi xảy ra</h2>
          <p className="break-words text-sm text-muted-foreground">{error.message}</p>
        </div>
        <Button onClick={() => window.location.reload()} className="h-10 rounded-lg px-5">
          <RotateCw className="mr-2 h-4 w-4" aria-hidden />
          Tải lại trang
        </Button>
      </div>
    </div>
  )
}
