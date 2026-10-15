import { describe, expect, it } from "vitest"
import { isServerlessRuntime, serverlessRewrites, toNestPath } from "../lib/serverless-runtime"

describe("serverless-runtime", () => {
  it("không đặt cờ → chế độ cũ", () => {
    expect(isServerlessRuntime({})).toBe(false)
    expect(isServerlessRuntime({ TRINITY_RUNTIME: "server" })).toBe(false)
  })

  it("TRINITY_RUNTIME=serverless (không phân biệt hoa-thường/khoảng trắng)", () => {
    expect(isServerlessRuntime({ TRINITY_RUNTIME: " Serverless " })).toBe(true)
  })

  it("rewrite: well-known (gốc + có đuôi) → điều phối vào /api/v1", () => {
    const rs = serverlessRewrites()
    for (const base of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"]) {
      expect(rs.some((r) => r.source === base)).toBe(true)
      expect(rs.some((r) => r.source === `${base}/:path*`)).toBe(true)
    }
    // Không rewrite nào được động tới `/api/v1/*` (route handler tự xử lý) — tránh vòng lặp.
    expect(rs.some((r) => r.source.startsWith("/api/v1"))).toBe(false)
  })

  it("toNestPath: well-known → route OAuth của Nest, path khác giữ nguyên", () => {
    expect(toNestPath("/.well-known/oauth-authorization-server")).toBe("/api/v1/oauth/.well-known/oauth-authorization-server")
    expect(toNestPath("/.well-known/oauth-protected-resource/api/v1/mcp")).toBe("/api/v1/oauth/protected-resource")
    expect(toNestPath("/api/v1/contacts")).toBe("/api/v1/contacts")
    expect(toNestPath("/.well-known/oauth-authorization-serverX")).toBe("/.well-known/oauth-authorization-serverX")
  })
})
