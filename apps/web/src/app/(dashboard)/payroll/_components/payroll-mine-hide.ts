"use client"

// Công tắc «Ẩn số tiền» của «Phiếu của tôi»: nhớ theo thiết bị (localStorage), mặc định hiện. Chỉ là che hiển thị trên
// màn hình (vai kề bên nhìn trộm) — không phải bảo mật dữ liệu, nên không có API; API phiếu vẫn trả số như cũ.
import { useCallback, useSyncExternalStore } from "react"

export const HIDE_AMOUNTS_KEY = "trinity.payroll.hide-amounts"

export function readHidden(): boolean {
  try {
    return window.localStorage.getItem(HIDE_AMOUNTS_KEY) === "1"
  } catch {
    return false
  }
}

const listeners = new Set<() => void>()
let memory = false // khi localStorage bị chặn: giữ trong phiên

function subscribe(cb: () => void) {
  listeners.add(cb)
  window.addEventListener("storage", cb)
  return () => {
    listeners.delete(cb)
    window.removeEventListener("storage", cb)
  }
}

function snapshot(): boolean {
  try {
    return window.localStorage.getItem(HIDE_AMOUNTS_KEY) === "1"
  } catch {
    return memory
  }
}

export function useHideAmounts(): [boolean, () => void] {
  // Máy chủ luôn «hiện» để HTML khớp lần vẽ đầu; trình duyệt đọc giá trị đã lưu.
  const hidden = useSyncExternalStore(subscribe, snapshot, () => false)
  const toggle = useCallback(() => {
    const next = !snapshot()
    memory = next
    try {
      window.localStorage.setItem(HIDE_AMOUNTS_KEY, next ? "1" : "0")
    } catch {
      /* chế độ riêng tư / chặn lưu trữ: vẫn đổi trong phiên */
    }
    listeners.forEach((cb) => cb())
  }, [])
  return [hidden, toggle]
}
