// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { act, renderHook } from "@testing-library/react"
import { APP_NAV_MINI_STORAGE_KEY, useAppNavMini } from "@/hooks/use-app-shell"

const src = (rel: string) => readFileSync(join(process.cwd(), "src", rel), "utf8")

/** matchMedia giả: chỉ trả `matches` theo bề rộng đã đặt cho truy vấn min/max-width. */
function setWidth(width: number) {
  window.matchMedia = ((query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query)
    const max = /max-width:\s*(\d+)px/.exec(query)
    const matches = (!min || width >= +min[1]) && (!max || width <= +max[1])
    return {
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as MediaQueryList
  }) as typeof window.matchMedia
}

// jsdom ở môi trường này không đảm bảo có localStorage → dựng bản trong bộ nhớ.
beforeEach(() => {
  const store = new Map<string, string>()
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  })
})
afterEach(() => window.localStorage.clear())

describe("sidebar mặc định mini ở iPad dọc", () => {
  it("768–1023px, chưa lưu lựa chọn → mini", () => {
    for (const w of [768, 900, 1023]) {
      setWidth(w)
      expect(renderHook(() => useAppNavMini()).result.current.navMini, String(w)).toBe(true)
    }
  })
  it("≥1024px và <768px, chưa lưu → mở rộng (không đổi)", () => {
    for (const w of [375, 639, 767, 1024, 1440]) {
      setWidth(w)
      expect(renderHook(() => useAppNavMini()).result.current.navMini, String(w)).toBe(false)
    }
  })
  it("user đã tự mở ('0') thì tôn trọng dù đang ở iPad dọc", () => {
    setWidth(820)
    window.localStorage.setItem(APP_NAV_MINI_STORAGE_KEY, "0")
    expect(renderHook(() => useAppNavMini()).result.current.navMini).toBe(false)
  })
  it("user đã thu gọn ('1') thì giữ mini ở màn rộng", () => {
    setWidth(1440)
    window.localStorage.setItem(APP_NAV_MINI_STORAGE_KEY, "1")
    expect(renderHook(() => useAppNavMini()).result.current.navMini).toBe(true)
  })
  it("setNavMini(false) ở iPad dọc ghi '0' và cập nhật ngay", () => {
    setWidth(820)
    const { result } = renderHook(() => useAppNavMini())
    expect(result.current.navMini).toBe(true)
    act(() => result.current.setNavMini(false))
    expect(result.current.navMini).toBe(false)
    expect(window.localStorage.getItem(APP_NAV_MINI_STORAGE_KEY)).toBe("0")
  })
})

describe("khoá mã nguồn dialog + topbar", () => {
  it("DialogContent giới hạn cao + cuộn ở mọi cỡ, max-sm giữ nguyên", () => {
    const d = src("components/ui/dialog.tsx")
    expect(d).toContain("max-h-[calc(100dvh-2rem)] overflow-y-auto")
    expect(d).toContain("max-sm:max-h-[90dvh]")
  })
  it("Topbar: nút thu gọn flex-none, breadcrumb overflow-hidden, ô tìm min-w-0", () => {
    const t = src("components/app-shell/topbar.tsx")
    expect(t).toContain("size-[34px] flex-none")
    expect(t).toContain("min-w-0 flex-1 overflow-hidden")
    // Giao diện mới: ô tìm là nút gọn "Tìm hoặc ra lệnh ⌘K" (tự co theo chữ) thay ô giả rộng 380px.
    expect(t).toContain("h-[34px] min-w-0 flex-none")
  })
})
