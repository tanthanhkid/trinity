"use client"

import { useEffect, useRef, useState } from "react"

/**
 * Đo bề rộng thật của khung biểu đồ SVG để `viewBox` khớp 1:1 với pixel.
 *
 * Vì sao cần: các biểu đồ SVG cũ vẽ trên `viewBox` rộng cố định (vd 720) rồi co giãn
 * theo khung ⇒ chữ trục `fontSize={10}` trong khung 400px chỉ còn ~5,5px thật, còn khung
 * 1100px thì phình 15px. Đo bề rộng rồi dùng chính nó làm bề rộng `viewBox` ⇒ 1 đơn vị =
 * 1px, chữ 14 là 14px thật ở mọi cỡ màn (luật chữ tối thiểu 14px của giao diện mới).
 *
 * Môi trường không có `ResizeObserver` (jsdom trong test, SSR) giữ `fallback`.
 */
export function useMeasuredWidth<T extends HTMLElement = HTMLDivElement>(fallback: number, min = 0) {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(fallback)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === "undefined") return
    const apply = (w: number) => {
      const next = Math.max(min, Math.round(w))
      if (next > 0) setWidth((prev) => (prev === next ? prev : next))
    }
    apply(el.getBoundingClientRect().width)
    const ro = new ResizeObserver((entries) => {
      const e = entries[0]
      if (e) apply(e.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [min])
  return [ref, width] as const
}
