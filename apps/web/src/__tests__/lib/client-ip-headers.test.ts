import { describe, expect, it } from "vitest"
import { isClientIpHeader } from "@/lib/client-ip-headers"

describe("isClientIpHeader", () => {
  it("chặn mọi header IP do client gửi, kể cả x-trinity-client-ip / x-trinity-peer-ip; giữ x-trinity-signature", () => {
    for (const h of ["X-Forwarded-For", "x-real-ip", "CF-Connecting-IP", "forwarded", "true-client-ip", "x-trinity-client-ip", "x-trinity-peer-ip"]) {
      expect(isClientIpHeader(h)).toBe(true)
    }
    for (const h of ["authorization", "content-type", "x-api-key", "cookie", "x-trinity-signature", "X-Trinity-Event"]) expect(isClientIpHeader(h)).toBe(false)
  })
})

