import { useSyncExternalStore } from 'react'

const QUERY = '(min-width: 1024px)'

/** ≥1024px = bố cục desktop của «Ánh xanh». Server/hydrate coi là false (mobile) rồi cập nhật. */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mql = window.matchMedia(QUERY)
      mql.addEventListener('change', cb)
      return () => mql.removeEventListener('change', cb)
    },
    () => window.matchMedia(QUERY).matches,
    () => false,
  )
}
