import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import { GET } from "@/app/uploads/[...path]/route"

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(
    new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } }),
  )
  vi.stubGlobal("fetch", fetchMock)
})

const call = (path: string[]) =>
  GET(new NextRequest("http://localhost/uploads/x"), { params: Promise.resolve({ path }) })

describe("proxy /uploads", () => {
  it("chặn '..', segment chứa '/' hoặc '\\' (đã giải mã từ %2f/%5c) và segment rỗng", async () => {
    for (const path of [["..", "x"], ["products", "../api"], ["products", "..\\x"], ["a", ""]]) {
      expect((await call(path)).status).toBe(400)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("phục vụ ảnh kèm nosniff và mã hoá từng segment khi chuyển tiếp", async () => {
    const res = await call(["products", "a b.png"])
    expect(res.status).toBe(200)
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/uploads\/products\/a%20b\.png$/)
  })
})

describe("proxy /uploads — serverless", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("Blob không có file → 404 thật, KHÔNG proxy sang backend (không có backend ở serverless)", async () => {
    vi.stubEnv("TRINITY_RUNTIME", "serverless")
    const res = await call(["products", "none.png"])
    expect(res.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
