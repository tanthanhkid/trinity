"use client"

import { useCallback, useEffect, useState, type RefObject } from "react"

/**
 * Popover mở bên trong Dialog/Sheet Base-UI. Mặc định gắn popup vào
 * CHÍNH Dialog/Sheet chứa `ref` (nằm trong cây DOM của nó → không bao giờ bị
 * coi là "outside press"). Ngoại lệ: Dialog có `overflow` khác `visible`
 * (vd `overflow-hidden`/`overflow-y-auto`) sẽ CẮT/ cuộn popup nằm bên trong →
 * trả `null` để portal ra `body`; khi đó Base-UI vẫn coi popup là con của
 * Dialog nhờ cây React lồng nhau (đã có test: bấm trong popup không đóng Dialog).
 * Gọi `resolve()` ngay lúc mở popover.
 */
export function usePopoverContainer(ref: RefObject<HTMLElement | null>) {
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const resolve = useCallback(() => {
    const host = ref.current?.closest<HTMLElement>('[data-slot="dialog-content"],[data-slot="sheet-content"]')
    if (!host) return setContainer(null)
    const cs = window.getComputedStyle(host)
    const clips = /hidden|auto|scroll|clip/.test(`${cs.overflow} ${cs.overflowX} ${cs.overflowY}`)
    setContainer(clips ? null : host)
  }, [ref])
  return { container, resolve }
}

/** `matchMedia` an toàn SSR (mặc định `false` ở lần render đầu). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false)
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return
    const mql = window.matchMedia(query)
    const sync = () => setMatches(mql.matches)
    sync()
    mql.addEventListener("change", sync)
    return () => mql.removeEventListener("change", sync)
  }, [query])
  return matches
}
