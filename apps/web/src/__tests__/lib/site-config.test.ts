import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  SITE_CONFIG_CACHE_KEY,
  SITE_CONFIG_EVENT,
  SITE_CONFIG_GLOBAL,
  SITE_CONFIG_INIT_SCRIPT,
  fetchSiteConfig,
  parseSiteConfig,
  readSiteConfig,
  resolveDsV2,
  resolvePollMode,
} from "@/lib/site-config"
import { isPollMode } from "@/lib/realtime-mode"

const win = window as unknown as Record<string, unknown>

afterEach(() => {
  delete win[SITE_CONFIG_GLOBAL]
  vi.unstubAllEnvs()
})

const full = {
  legal: {
    contact_email: " ops@example.test ",
    company_name: "Công ty ABC",
    company_name_en: null,
    company_tax_id: "0312345678",
    company_address: "",
    company_phone: 5,
  },
  realtime_mode: "poll",
  ds_v2: true,
}

describe("parseSiteConfig", () => {
  it("chuẩn hoá: cắt khoảng trắng, rỗng/sai kiểu thành null", () => {
    const c = parseSiteConfig(full)
    expect(c?.legal.contact_email).toBe("ops@example.test")
    expect(c?.legal.company_address).toBeNull()
    expect(c?.legal.company_phone).toBeNull()
    expect(c?.realtime_mode).toBe("poll")
    expect(c?.ds_v2).toBe(true)
  })
  it("hình dạng lạ ⇒ null; thiếu trường ⇒ mặc định socket / tắt", () => {
    expect(parseSiteConfig(null)).toBeNull()
    expect(parseSiteConfig([])).toBeNull()
    expect(parseSiteConfig("x")).toBeNull()
    const c = parseSiteConfig({})
    expect(c?.realtime_mode).toBe("socket")
    expect(c?.ds_v2).toBe(false)
    expect(c?.legal.company_name).toBeNull()
  })
  it("ds_v2 chỉ nhận boolean true", () => {
    expect(parseSiteConfig({ ds_v2: "true" })?.ds_v2).toBe(false)
  })
})

describe("cờ lúc chạy ưu tiên hơn cờ lúc build", () => {
  it("chưa có cấu hình ⇒ lùi về NEXT_PUBLIC_*", () => {
    expect(readSiteConfig()).toBeNull()
    expect(resolveDsV2()).toBe(false)
    vi.stubEnv("NEXT_PUBLIC_DS_V2", "true")
    vi.stubEnv("NEXT_PUBLIC_REALTIME_MODE", "poll")
    expect(resolveDsV2()).toBe(true)
    expect(resolvePollMode()).toBe(true)
    expect(isPollMode()).toBe(true)
  })
  it("có cấu hình ⇒ theo cấu hình, bỏ qua env build", () => {
    vi.stubEnv("NEXT_PUBLIC_DS_V2", "true")
    vi.stubEnv("NEXT_PUBLIC_REALTIME_MODE", "poll")
    win[SITE_CONFIG_GLOBAL] = { ...full, realtime_mode: "socket", ds_v2: false }
    expect(resolveDsV2()).toBe(false)
    expect(isPollMode()).toBe(false)
    win[SITE_CONFIG_GLOBAL] = full
    expect(resolveDsV2()).toBe(true)
    expect(isPollMode()).toBe(true)
  })
})

describe("fetchSiteConfig", () => {
  it("200 ⇒ cấu hình đã chuẩn hoá", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => full })
    const c = await fetchSiteConfig(f as unknown as typeof fetch)
    expect(f.mock.calls[0][0]).toBe("/api/v1/site-config")
    expect(c?.legal.company_name).toBe("Công ty ABC")
  })
  it("404 hoặc lỗi mạng ⇒ null, không ném", async () => {
    const notFound = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) })
    expect(await fetchSiteConfig(notFound as unknown as typeof fetch)).toBeNull()
    const boom = vi.fn().mockRejectedValue(new Error("net"))
    expect(await fetchSiteConfig(boom as unknown as typeof fetch)).toBeNull()
  })
})

describe("SITE_CONFIG_INIT_SCRIPT", () => {
  const run = () => new Function(SITE_CONFIG_INIT_SCRIPT)()
  const flush = () => new Promise((r) => setTimeout(r, 0))
  beforeEach(() => {
    // jsdom của bộ test này không có Storage đầy đủ: dùng bản nhớ trong bộ nhớ.
    const m = new Map<string, string>()
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    document.documentElement.removeAttribute("data-ds")
  })
  it("không dùng XHR đồng bộ", () => {
    expect(SITE_CONFIG_INIT_SCRIPT).not.toContain("XMLHttpRequest")
  })
  it("có cache ⇒ áp ngay, không đợi mạng", () => {
    localStorage.setItem(SITE_CONFIG_CACHE_KEY, JSON.stringify(full))
    vi.stubGlobal("fetch", () => new Promise(() => {}))
    run()
    expect(win[SITE_CONFIG_GLOBAL]).toEqual(full)
    expect(document.documentElement.getAttribute("data-ds")).toBe("v2")
  })
  it("fetch về ⇒ lưu cache, áp data-ds, phát sự kiện", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => full }))
    const ev = vi.fn()
    window.addEventListener(SITE_CONFIG_EVENT, ev)
    run()
    await flush()
    window.removeEventListener(SITE_CONFIG_EVENT, ev)
    expect(win[SITE_CONFIG_GLOBAL]).toEqual(full)
    expect(document.documentElement.getAttribute("data-ds")).toBe("v2")
    expect(JSON.parse(localStorage.getItem(SITE_CONFIG_CACHE_KEY) as string)).toEqual(full)
    expect(ev).toHaveBeenCalled()
  })
  it("ds_v2 false từ máy chủ ⇒ gỡ data-ds của cache cũ", async () => {
    localStorage.setItem(SITE_CONFIG_CACHE_KEY, JSON.stringify(full))
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...full, ds_v2: false }) }))
    run()
    await flush()
    expect(document.documentElement.hasAttribute("data-ds")).toBe(false)
  })
  it("404 / JSON hỏng ⇒ im lặng, không lưu gì", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }))
    run()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error("x") } }))
    run()
    await flush()
    expect(win[SITE_CONFIG_GLOBAL]).toBeUndefined()
    expect(localStorage.getItem(SITE_CONFIG_CACHE_KEY)).toBeNull()
  })
})
