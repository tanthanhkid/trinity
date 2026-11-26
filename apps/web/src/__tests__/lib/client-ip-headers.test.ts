import { describe, expect, it } from "vitest"
import { isClientIpHeader, webTunnelListenProblem } from "@/lib/client-ip-headers"

describe("isClientIpHeader", () => {
  it("chặn mọi header IP do client gửi, kể cả x-trinity-*", () => {
    for (const h of ["X-Forwarded-For", "x-real-ip", "CF-Connecting-IP", "forwarded", "true-client-ip", "x-trinity-client-ip", "x-trinity-peer-ip"]) {
      expect(isClientIpHeader(h)).toBe(true)
    }
    for (const h of ["authorization", "content-type", "x-api-key", "cookie"]) expect(isClientIpHeader(h)).toBe(false)
  })
})

describe("webTunnelListenProblem", () => {
  it("cloudflare-tunnel bắt buộc HOSTNAME loopback", () => {
    expect(webTunnelListenProblem({ TRUSTED_PROXY: "cloudflare-tunnel", HOSTNAME: "0.0.0.0" })).toMatch(/không phải loopback/)
    expect(webTunnelListenProblem({ TRUSTED_PROXY: "cloudflare-tunnel" })).toMatch(/không phải loopback/)
    expect(webTunnelListenProblem({ TRUSTED_PROXY: "cloudflare-tunnel", HOSTNAME: "127.0.0.1" })).toBeNull()
    expect(webTunnelListenProblem({ TRUSTED_PROXY: "none", HOSTNAME: "0.0.0.0" })).toBeNull()
  })
})
