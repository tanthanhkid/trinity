import { useSyncExternalStore } from "react"

const QUERY = "(max-width: 639px)"

function subscribe(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => {}
  const mql = window.matchMedia(QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

/**
 * `true` khi viewport < 640px (điện thoại; cùng mốc `max-sm:` / `ShellResponsiveList`).
 * SSR và lần render hydrate đầu trả `false` (bố cục desktop) rồi cập nhật ngay
 * sau hydrate — chỉ dùng cho nhánh KHÔNG thể làm bằng CSS (vd chọn nơi render
 * children của `MobileFilterSheet`). Ưu tiên `max-sm:` khi có thể.
 */
export function useIsPhone(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => typeof window.matchMedia === "function" && window.matchMedia(QUERY).matches,
    () => false,
  )
}
