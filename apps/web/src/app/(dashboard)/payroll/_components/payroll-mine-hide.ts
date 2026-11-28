"use client"

// Công tắc «Ẩn số tiền» của «Phiếu của tôi»: nhớ theo thiết bị (localStorage), mặc định hiện. Chỉ là che hiển thị trên
// màn hình (vai kề bên nhìn trộm) — không phải bảo mật dữ liệu, nên không có API; API phiếu vẫn trả số như cũ.
import { useSyncExternalStore } from "react"

export const HIDE_AMOUNTS_KEY = "trinity.payroll.hide-amounts"

const listeners = new Set<() => void>()
// Giá trị trong phiên khi localStorage không ghi/đọc được (chế độ riêng tư, đầy bộ nhớ). `null` = đọc từ localStorage.
let memory: boolean | null = null

function subscribe(cb: () => void) {
  listeners.add(cb)
  window.addEventListener("storage", cb)
  return () => {
    listeners.delete(cb)
    window.removeEventListener("storage", cb)
  }
}

/** Trạng thái hiện tại: giá trị trong phiên (khi lưu trữ hỏng) thắng, rồi tới localStorage, mặc định hiện. */
export function readHidden(): boolean {
  if (memory !== null) return memory
  try {
    return window.localStorage.getItem(HIDE_AMOUNTS_KEY) === "1"
  } catch {
    return false
  }
}

/** Đổi công tắc; ghi localStorage hỏng thì vẫn đổi trong phiên. */
export function toggleHidden(): void {
  const next = !readHidden()
  try {
    window.localStorage.setItem(HIDE_AMOUNTS_KEY, next ? "1" : "0")
    memory = null
  } catch {
    memory = next
  }
  listeners.forEach((cb) => cb())
}

/** Chỉ cho test: xoá giá trị trong phiên. */
export function resetHiddenMemory(): void {
  memory = null
}

export function useHideAmounts(): [boolean, () => void] {
  // Máy chủ luôn «hiện» để HTML khớp lần vẽ đầu; trình duyệt đọc giá trị đã lưu.
  const hidden = useSyncExternalStore(subscribe, readHidden, () => false)
  return [hidden, toggleHidden]
}
