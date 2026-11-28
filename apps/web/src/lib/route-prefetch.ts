import type { QueryClient } from '@tanstack/react-query'
import { EMPTY_FILTER, INTERACTION_STATS_KEY, fetchInteractionStats, fetchInteractions, interactionListKey } from './inbox-queries'

/**
 * Nạp trước DỮ LIỆU của màn kế khi rê chuột / focus vào mục menu (cùng lúc `router.prefetch` nạp trước mã), để lúc bấm
 * dữ liệu đã về hoặc đang về. Chỉ làm cho màn có khoá + hàm nạp dùng chung với chính màn đó (không nhân đôi logic).
 * Lỗi nuốt: nạp trước chỉ là tối ưu. `staleTime` ngắn để không giữ dữ liệu cũ quá lâu.
 */
const WARM_STALE_MS = 15_000

const warmed = new Map<string, number>()

export function prefetchRouteData(qc: QueryClient, href: string): void {
  const path = href.split(/[?#]/)[0]?.replace(/\/$/, '') ?? ''
  const last = warmed.get(path) ?? 0
  if (Date.now() - last < WARM_STALE_MS) return
  switch (path) {
    case '/inbox':
      warmed.set(path, Date.now())
      void qc.prefetchQuery({ queryKey: INTERACTION_STATS_KEY, queryFn: fetchInteractionStats, staleTime: WARM_STALE_MS })
      void qc.prefetchQuery({ queryKey: interactionListKey(EMPTY_FILTER), queryFn: () => fetchInteractions(EMPTY_FILTER), staleTime: WARM_STALE_MS })
      return
    default:
      return
  }
}
