import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { signClientIpHeader, verifyClientIpHeader } from "@/lib/client-ip-headers"

/**
 * Route proxy `/api/v1/*` (không serverless): KHÔNG chép header IP do client gửi sang API; gửi IP do tệp nạp trước
 * xác định, ký lại ngay trước khi gửi. Header giả/thiếu tệp nạp trước ⇒ `untrusted`.
 */
const SECRET = "s".repeat(64)
const SPOOF = {
  "x-forwarded-for": "203.0.113.108",
  "x-real-ip": "203.0.113.108",
  "cf-connecting-ip": "203.0.113.108",
  forwarded: "for=203.0.113.108",
  "x-trinity-peer-ip": "203.0.113.108",
  authorization: "Bearer t",
  "x-trinity-signature": "t=1,v1=abc",
}

async function forwarded(extra: Record<string, string>) {
  const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))
  vi.stubGlobal("fetch", fetchMock)
  const { GET } = await import("@/app/api/v1/[...path]/route")
  await GET(new NextRequest("http://localhost:3000/api/v1/auth/me", { headers: { ...SPOOF, ...extra } }))
  expect(fetchMock).toHaveBeenCalledTimes(1)
  return new Headers(fetchMock.mock.calls[0][1].headers)
}

describe("proxy /api/v1 và IP khách", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it("header IP của client không tới API; IP do tệp nạp trước ký được ký lại", async () => {
    vi.stubEnv("INTERNAL_SERVICE_SECRET", SECRET)
    const sent = await forwarded({ "x-trinity-client-ip": signClientIpHeader("198.51.100.4", { INTERNAL_SERVICE_SECRET: SECRET }) })
    for (const h of ["x-forwarded-for", "x-real-ip", "cf-connecting-ip", "forwarded", "x-trinity-peer-ip"]) expect(sent.get(h)).toBeNull()
    expect(verifyClientIpHeader(sent.get("x-trinity-client-ip"), { INTERNAL_SERVICE_SECRET: SECRET })).toBe("198.51.100.4")
    expect(sent.get("authorization")).toBe("Bearer t")
    // Webhook vào ký bằng X-Trinity-Signature đi qua web nguyên vẹn.
    expect(sent.get("x-trinity-signature")).toBe("t=1,v1=abc")
  })

  it("x-trinity-client-ip giả (thiếu tệp nạp trước) ⇒ gửi untrusted có chữ ký, không phải IP giả", async () => {
    vi.stubEnv("INTERNAL_SERVICE_SECRET", SECRET)
    const sent = await forwarded({ "x-trinity-client-ip": "203.0.113.108;1;forged" })
    expect(verifyClientIpHeader(sent.get("x-trinity-client-ip"), { INTERNAL_SERVICE_SECRET: SECRET })).toBe("untrusted")
  })

  it("web không có bí mật nội bộ ⇒ dấu untrusted không chữ ký", async () => {
    vi.stubEnv("INTERNAL_SERVICE_SECRET", "")
    vi.stubEnv("SERVICE_SECRET", "")
    const sent = await forwarded({})
    expect(sent.get("x-trinity-client-ip")).toBe("untrusted")
  })
})
