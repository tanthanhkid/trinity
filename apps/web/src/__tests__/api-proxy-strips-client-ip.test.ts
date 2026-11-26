import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/** Route proxy `/api/v1/*` (không serverless) KHÔNG chép header IP do client gửi sang API — client không tự khai IP được. */
describe("proxy /api/v1 xoá header IP của client", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("x-forwarded-for, x-real-ip, cf-connecting-ip, forwarded, x-trinity-* không tới API; header khác giữ nguyên", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))
    vi.stubGlobal("fetch", fetchMock)
    const { GET } = await import("@/app/api/v1/[...path]/route")
    const req = new NextRequest("http://localhost:3000/api/v1/auth/me", {
      headers: {
        "x-forwarded-for": "203.0.113.108",
        "x-real-ip": "203.0.113.108",
        "cf-connecting-ip": "203.0.113.108",
        forwarded: "for=203.0.113.108",
        "x-trinity-client-ip": "203.0.113.108;1;x",
        authorization: "Bearer t",
      },
    })
    await GET(req)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const sent = new Headers(fetchMock.mock.calls[0][1].headers)
    for (const h of ["x-forwarded-for", "x-real-ip", "cf-connecting-ip", "forwarded", "x-trinity-client-ip"]) expect(sent.get(h)).toBeNull()
    expect(sent.get("authorization")).toBe("Bearer t")
  })
})
