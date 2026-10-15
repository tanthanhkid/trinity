/**
 * Metadata OAuth/MCP ở GỐC domain (`/.well-known/…`) phải tới được monolith mà KHÔNG cần sửa
 * reverse proxy (chỉ có 2 location: `/api/v1/` → monolith, `/` → Next). Khoá: rewrite trong next.config + middleware để ngỏ đường này
 * (máy chủ của ChatGPT/Claude không có phiên đăng nhập) + proxy dev biết prefix `/api/v1/oauth`.
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { NextRequest } from "next/server"
import nextConfig from "../../../next.config"
import { proxy as middleware } from "../../proxy"

type Rule = { source: string; destination: string }

async function rules(): Promise<Rule[]> {
  const r = await nextConfig.rewrites!()
  return (Array.isArray(r) ? r : (r.beforeFiles ?? [])) as Rule[]
}

describe("well-known OAuth/MCP", () => {
  it("rewrite gốc + biến thể có path (RFC 8414 / 9728) sang đúng route của monolith", async () => {
    const rs = await rules()
    const dest = (src: string) => rs.find((r) => r.source === src)?.destination
    const AS = "http://127.0.0.1:4000/api/v1/oauth/.well-known/oauth-authorization-server"
    const PRM = "http://127.0.0.1:4000/api/v1/oauth/protected-resource"
    expect(dest("/.well-known/oauth-authorization-server")).toBe(AS)
    expect(dest("/.well-known/oauth-authorization-server/:path*")).toBe(AS)
    expect(dest("/.well-known/oauth-protected-resource")).toBe(PRM)
    expect(dest("/.well-known/oauth-protected-resource/:path*")).toBe(PRM)
  })

  it("rewrite chỉ trỏ tới /api/v1/oauth (không mở đường nào khác của monolith)", async () => {
    for (const r of await rules()) expect(r.destination).toMatch(/^http:\/\/127\.0\.0\.1:4000\/api\/v1\/oauth\//)
  })

  it("proxy (ex-middleware) cho đi thẳng /.well-known (không đá về /login — máy chủ AI không có phiên)", () => {
    const wk = middleware(new NextRequest("https://crm.example.com/.well-known/oauth-protected-resource/api/v1/mcp"))
    expect(wk.status).toBe(200)
    expect(wk.headers.get("location")).toBeNull()
  })

  it("proxy dev (LOCAL_ROUTES) có /api/v1/oauth + /api/v1/mcp", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/v1/[...path]/route.ts"), "utf8")
    expect(src).toContain("'/api/v1/oauth': 'http://localhost:4000'")
    expect(src).toContain("'/api/v1/mcp': 'http://localhost:4000'")
  })

  it("màn đồng ý chống clickjacking: frame-ancestors 'none' + X-Frame-Options DENY", async () => {
    const hs = await nextConfig.headers!()
    const rule = hs.find((h) => h.source === "/oauth/authorize")
    const val = (k: string) => rule?.headers.find((x) => x.key === k)?.value
    expect(val("Content-Security-Policy")).toBe("frame-ancestors 'none'")
    expect(val("X-Frame-Options")).toBe("DENY")
    expect(val("Referrer-Policy")).toBe("no-referrer")
  })
})
