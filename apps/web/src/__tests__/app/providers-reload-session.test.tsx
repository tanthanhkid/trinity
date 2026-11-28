import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, waitFor, cleanup } from "@testing-library/react"

/**
 * Tái hiện sự cố #639: đăng nhập → tải lại trang đầy đủ (mount lại Providers) ⇒ token PHẢI còn nguyên,
 * không được gọi `clearTokens`/`forceLogout`, không gọi API nào mà thiếu Authorization.
 */
const forceLogout = vi.fn()
vi.mock("@/lib/api-client", () => ({ forceLogout: (...a: unknown[]) => forceLogout(...a), performTokenRefresh: vi.fn(), default: {} }))
vi.mock("@/lib/monitoring", () => ({ bootMonitoring: async () => {}, identifyMonitoringUser: async () => {} }))
vi.mock("@/lib/fe-logger", () => ({ initGlobalErrorHandlers: () => {}, logFrontendError: () => {} }))
vi.mock("@/components/build-id-watcher", () => ({ BuildIdWatcher: () => null }))
vi.mock("@/components/chunk-error-watcher", () => ({ ChunkErrorWatcher: () => null }))
vi.mock("@/components/token-refresh-scheduler", () => ({ TokenRefreshScheduler: () => null }))

import Providers from "@/app/providers"
import { useAuthStore } from "@/store/auth"

const TOKEN = "header.payload.sig"

// jsdom của môi trường này thiếu localStorage hoạt động (cờ --localstorage-file): dựng kho trong bộ nhớ.
const mem = new Map<string, string>()
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
})

function login() {
  localStorage.setItem("trinity_access_token", TOKEN)
  localStorage.setItem("trinity_refresh_token", "refresh-1")
  document.cookie = `access_token=${TOKEN}; path=/`
  document.cookie = "has_session=1; path=/"
  useAuthStore.setState({
    user: { id: 7, email: "a@b.c", full_name: "A", avatar_url: null, manager_id: null },
    company: { id: 1, name: "C", multi_tenant: false },
    accessToken: TOKEN,
    refreshToken: "refresh-1",
    _hasHydrated: true,
  })
}

beforeEach(() => {
  localStorage.clear()
  forceLogout.mockReset()
})
afterEach(() => cleanup())

describe("tải lại trang sau đăng nhập", () => {
  it("mount Providers lần 2 (như tải lại đầy đủ) giữ nguyên token và không đăng xuất", async () => {
    login()
    const first = render(<Providers><div>trang</div></Providers>)
    await new Promise((r) => setTimeout(r, 50))
    first.unmount()
    // "Tải lại": mount mới trên cùng localStorage/IndexedDB.
    render(<Providers><div>trang</div></Providers>)
    await waitFor(() => expect(useAuthStore.getState()._hasHydrated).toBe(true))
    await new Promise((r) => setTimeout(r, 100))
    expect(localStorage.getItem("trinity_access_token")).toBe(TOKEN)
    expect(localStorage.getItem("trinity_refresh_token")).toBe("refresh-1")
    expect(useAuthStore.getState().accessToken).toBe(TOKEN)
    expect(forceLogout).not.toHaveBeenCalled()
  })
})
