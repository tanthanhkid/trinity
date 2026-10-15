"use client"

import { useCallback, useEffect, useSyncExternalStore } from "react"
import { readUiPref } from "@/lib/ui-pref-storage"

/**
 * Cơ chế khung (shell) của giao diện. Tách khỏi component để
 * `app/(dashboard)/layout.tsx` giữ được cấu trúc provider cố định (ràng buộc
 * xem chú thích trong layout).
 */

/** Khoá localStorage cho trạng thái thu gọn sidebar (UI kit dùng `mx-mini`). */
export const APP_NAV_MINI_STORAGE_KEY = "trinity-ui-nav-mini"

const listeners = new Set<() => void>()

/**
 * Dải "iPad dọc": từ mốc `useIsMobile` (768) tới dưới 1024px, sidebar
 * mở 186px chỉ còn ~512px cho nội dung → MẶC ĐỊNH thu gọn khi user CHƯA tự lưu
 * lựa chọn. < 768px là Sheet trượt (không dùng `open`) nên giữ nguyên mặc định cũ.
 */
export const NAV_MINI_DEFAULT_MIN_WIDTH = 768
export const NAV_MINI_DEFAULT_MAX_WIDTH = 1023
const NAV_MINI_DEFAULT_QUERY = `(min-width: ${NAV_MINI_DEFAULT_MIN_WIDTH}px) and (max-width: ${NAV_MINI_DEFAULT_MAX_WIDTH}px)`

/** Mặc định khi chưa có lựa chọn đã lưu: mini trong dải iPad dọc, còn lại mở rộng. */
function defaultNavMini(): boolean {
  try {
    return window.matchMedia(NAV_MINI_DEFAULT_QUERY).matches
  } catch {
    return false
  }
}

function readNavMini(): boolean {
  try {
    const stored = readUiPref(APP_NAV_MINI_STORAGE_KEY)
    // User đã tự bấm (kể cả mở: "0") → tôn trọng tuyệt đối, không theo bề rộng.
    if (stored === "1") return true
    if (stored === "0") return false
    return defaultNavMini()
  } catch {
    // Trình duyệt chặn site data / chế độ riêng tư → theo mặc định theo bề rộng.
    return defaultNavMini()
  }
}

/** Trên server không có `localStorage` → luôn mở rộng (khớp mặc định client). */
function readNavMiniOnServer(): boolean {
  return false
}

function subscribeNavMini(onChange: () => void): () => void {
  listeners.add(onChange)
  // Đồng bộ giữa các tab: tab khác đổi trạng thái thì tab này cập nhật theo.
  window.addEventListener("storage", onChange)
  // Xoay iPad / đổi cỡ cửa sổ qua mốc 768/1024 khi chưa có lựa chọn đã lưu.
  const mql = window.matchMedia?.(NAV_MINI_DEFAULT_QUERY)
  mql?.addEventListener?.("change", onChange)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener("storage", onChange)
    mql?.removeEventListener?.("change", onChange)
  }
}

/**
 * Sidebar thu gọn (186px ↔ 64px), nhớ theo từng máy qua `localStorage`.
 *
 * Dùng `useSyncExternalStore` chứ KHÔNG `useState` + `useEffect`:
 *  · `useState` initializer chạy CẢ trên server (layout vẫn được SSR) — ở đó
 *    không có `localStorage`, và giá trị server ≠ client gây hydration mismatch.
 *  · đọc trong `useEffect` rồi `setState` là cascading render (eslint
 *    `react-hooks/set-state-in-effect` chặn, ).
 * `useSyncExternalStore` có sẵn nhánh `getServerSnapshot` cho đúng ca này.
 */
export function useAppNavMini(): {
  navMini: boolean
  setNavMini: (value: boolean) => void
} {
  const navMini = useSyncExternalStore(
    subscribeNavMini,
    readNavMini,
    readNavMiniOnServer,
  )

  const setNavMini = useCallback((value: boolean) => {
    try {
      window.localStorage.setItem(APP_NAV_MINI_STORAGE_KEY, value ? "1" : "0")
    } catch {
      // Không ghi được thì chỉ mất tiện nghi ghi nhớ — vẫn phải bắn listener
      // để UI đổi ngay trong phiên hiện tại.
    }
    for (const listener of listeners) listener()
  }, [])

  return { navMini, setNavMini }
}

/**
 * Gắn `data-ui="app"` + class font lên `<html>`.
 *
 * PHẢI là `<html>`, KHÔNG phải div bọc: Dialog/Select/Popover của Base-UI
 * portal ra `document.body`, nên scope token ở div sẽ để overlay thoát ra
 * ngoài và mất token.
 *
 * `data-ui="app"` là PHẠM VI của 2 khối override cuối `styles/app-tokens.css`
 * (phần vá tương phản WCAG đo trên DOM thật) — gỡ attribute là mất phần vá đó,
 * nên đừng "dọn" nó chỉ vì tên có chữ v2.
 */
export function useAppDocumentTheme(fontClassName: string): void {
  useEffect(() => {
    const root = document.documentElement
    const fontClasses = fontClassName.split(" ").filter(Boolean)
    root.dataset.ui = "app"
    root.classList.add(...fontClasses)
    return () => {
      delete root.dataset.ui
      root.classList.remove(...fontClasses)
    }
  }, [fontClassName])
}
