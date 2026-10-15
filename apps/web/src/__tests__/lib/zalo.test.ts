import { describe, it, expect } from "vitest"
import { cleanPhone, buildZaloDirectUrl, isMaskedPhone } from "@/lib/zalo"

describe("cleanPhone", () => {
  it("giữ nguyên số local 0xxx", () => {
    expect(cleanPhone("0901234567")).toBe("0901234567")
  })

  it("bỏ khoảng trắng / dấu gạch / ngoặc / chấm", () => {
    expect(cleanPhone(" 090-123 4567 ")).toBe("0901234567")
    expect(cleanPhone("(090).123.4567")).toBe("0901234567")
  })

  it("chuyển +84xxx → 0xxx", () => {
    expect(cleanPhone("+84901234567")).toBe("0901234567")
    expect(cleanPhone("+84 90 123 4567")).toBe("0901234567")
  })

  it("chuyển 84xxx (11 số, không dấu +) → 0xxx", () => {
    expect(cleanPhone("84901234567")).toBe("0901234567")
  })

  it("KHÔNG đụng số bắt đầu 08x (không phải prefix 84 quốc gia)", () => {
    expect(cleanPhone("0900000002")).toBe("0900000002")
  })
})

describe("buildZaloDirectUrl", () => {
  it("dựng link zalo.me từ số đã chuẩn hoá", () => {
    expect(buildZaloDirectUrl("0901234567")).toBe("https://zalo.me/0901234567")
    expect(buildZaloDirectUrl("+84901234567")).toBe("https://zalo.me/0901234567")
  })
})

describe("isMaskedPhone", () => {
  it("nhận diện SĐT bị che (có dấu *)", () => {
    expect(isMaskedPhone("0900***001")).toBe(true)
    expect(isMaskedPhone("079-797-**17")).toBe(true)
  })

  it("số đầy đủ không bị coi là che", () => {
    expect(isMaskedPhone("0901234567")).toBe(false)
    expect(isMaskedPhone("+84901234567")).toBe(false)
  })
})
