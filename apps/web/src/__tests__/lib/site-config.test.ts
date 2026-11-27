import { afterEach, describe, expect, it, vi } from "vitest"
import {
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
  const stubXhr = (status: number, body: string) => {
    class X {
      status = status
      responseText = body
      open() {}
      setRequestHeader() {}
      send() {}
    }
    vi.stubGlobal("XMLHttpRequest", X)
  }
  afterEach(() => {
    vi.unstubAllGlobals()
    document.documentElement.removeAttribute("data-ds")
  })
  it("ds_v2 true ⇒ lưu cấu hình và gắn data-ds=v2 trước lần vẽ đầu", () => {
    stubXhr(200, JSON.stringify(full))
    run()
    expect(win[SITE_CONFIG_GLOBAL]).toEqual(full)
    expect(document.documentElement.getAttribute("data-ds")).toBe("v2")
  })
  it("ds_v2 false ⇒ gỡ data-ds", () => {
    document.documentElement.setAttribute("data-ds", "v2")
    stubXhr(200, JSON.stringify({ ...full, ds_v2: false }))
    run()
    expect(document.documentElement.hasAttribute("data-ds")).toBe(false)
  })
  it("404 / JSON hỏng ⇒ im lặng, không lưu gì", () => {
    stubXhr(404, "")
    run()
    stubXhr(200, "{hỏng")
    run()
    expect(win[SITE_CONFIG_GLOBAL]).toBeUndefined()
  })
})
