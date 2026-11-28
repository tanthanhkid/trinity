import { useSyncExternalStore } from "react"

const QUERY = "(min-width: 1024px)"

function subscribe(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => {}
  const mql = window.matchMedia(QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

/**
 * `true` khi viewport ≥ 1024px (desktop của «Ánh xanh»; cùng mốc `lg:` / StickyActionBar).
 * SSR và lần render hydrate đầu trả `false` rồi cập nhật ngay sau hydrate — chỉ dùng khi hai bố cục
 * khác nhau về CẤU TRÚC dữ liệu (không thể ẩn/hiện bằng `lg:`), để khỏi chạy hai bản truy vấn.
 */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => typeof window.matchMedia === "function" && window.matchMedia(QUERY).matches,
    () => false,
  )
}
