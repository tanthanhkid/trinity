import { describe, expect, it } from "vitest"
import { loginPathWithNext, readAuthorizeParams, safeExternalRedirect, safeNextPath } from "@/lib/oauth-authorize"

describe("readAuthorizeParams", () => {
  it("chỉ lấy đúng 8 tham số chuẩn, bỏ tham số lạ và giá trị quá dài", () => {
    const sp = new URLSearchParams({
      response_type: "code", client_id: "c1", redirect_uri: "https://a.example.com/cb", scope: "crm.read", state: "s",
      code_challenge: "x".repeat(43), code_challenge_method: "S256", resource: "https://crm.example.com/api/v1/mcp",
      evil: "1", javascript: "alert(1)",
    })
    const p = readAuthorizeParams(sp)
    expect(Object.keys(p).sort()).toEqual(["client_id", "code_challenge", "code_challenge_method", "redirect_uri", "resource", "response_type", "scope", "state"])
    expect(readAuthorizeParams(new URLSearchParams({ state: "a".repeat(5000), client_id: "ok" }))).toEqual({ client_id: "ok" })
    expect(readAuthorizeParams(new URLSearchParams({ client_id: "" }))).toEqual({})
  })
})

describe("safeExternalRedirect", () => {
  it("chỉ https hoặc http loopback", () => {
    expect(safeExternalRedirect("https://claude.ai/api/mcp/auth_callback?code=1&state=2")).toBe("https://claude.ai/api/mcp/auth_callback?code=1&state=2")
    expect(safeExternalRedirect("http://localhost:3118/callback?code=1")).toBe("http://localhost:3118/callback?code=1")
    expect(safeExternalRedirect("http://127.0.0.1/cb")).toBe("http://127.0.0.1/cb")
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "http://evil.example.com/cb", "https://u:p@a.example.com/cb", "myapp://cb", "//evil.example.com", "/relative", "", null, undefined, 5]) {
      expect(safeExternalRedirect(bad)).toBeNull()
    }
  })
})

describe("safeNextPath / loginPathWithNext", () => {
  it("chỉ nhận /oauth/authorize (+ query) — chống open redirect qua ?next=", () => {
    expect(safeNextPath("/oauth/authorize?client_id=x&state=y")).toBe("/oauth/authorize?client_id=x&state=y")
    expect(safeNextPath("/oauth/authorize")).toBe("/oauth/authorize")
    for (const bad of ["https://evil.example.com", "//evil.example.com", "/dashboard", "/oauth/authorizeX", "/oauth/authorize/../../login", "\\evil", "/oauth/authorize\\evil", "javascript:alert(1)", "", null, undefined, "/oauth/authorize\nSet-Cookie: x"]) {
      // `/oauth/authorize/../..` không khớp regex vì sau authorize phải là `?` hoặc hết chuỗi
      expect(safeNextPath(bad as string | null | undefined)).toBeNull()
    }
  })
  it("loginPathWithNext mã hoá URL; path khác ⇒ /login trần", () => {
    expect(loginPathWithNext("/oauth/authorize?a=1&b=2")).toBe("/login?next=%2Foauth%2Fauthorize%3Fa%3D1%26b%3D2")
    expect(loginPathWithNext("/contacts")).toBe("/login")
  })
})
