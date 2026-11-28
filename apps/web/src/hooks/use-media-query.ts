"use client"

import { useSyncExternalStore } from "react"

/**
 * Theo dõi một media query (vd `(min-width: 1024px)`). Phía máy chủ/lượt dựng đầu trả `false`
 * (bố cục điện thoại) rồi cập nhật ngay khi vào trình duyệt.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => {}
      const mql = window.matchMedia(query)
      mql.addEventListener("change", onChange)
      return () => mql.removeEventListener("change", onChange)
    },
    // jsdom/trình duyệt cũ không có `matchMedia` ⇒ coi như không khớp (bố cục điện thoại), không ném lỗi.
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
    () => false,
  )
}

/** Từ 1024px: bố cục desktop («Ánh xanh» tách hẳn desktop và điện thoại). */
export function useIsDesktop(): boolean {
  return useMediaQuery("(min-width: 1024px)")
}
