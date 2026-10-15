import { describe, expect, it } from "vitest"
import { toLocalPhone, formatPhone, maskPhone } from "@/lib/format"

describe("toLocalPhone — chuẩn hoá hiển thị về 0xxx", () => {
  it("84xxxxxxxxx (11 chữ số) → 0xxxxxxxxx", () => {
    expect(toLocalPhone("84900000001")).toBe("0900000001")
    expect(toLocalPhone("84901234567")).toBe("0901234567")
  })

  it("+84xxxxxxxxx → 0xxxxxxxxx (bỏ ký tự không phải số)", () => {
    expect(toLocalPhone("+84900000001")).toBe("0900000001")
    expect(toLocalPhone("+84 900 000 001")).toBe("0900000001")
  })

  it("0xxxxxxxxx (10 chữ số) — idempotent, giữ nguyên", () => {
    expect(toLocalPhone("0900000001")).toBe("0900000001")
    expect(toLocalPhone("0900 000 001")).toBe("0900000001")
  })

  it("9 chữ số mất leading 0 (Excel) → thêm 0 nếu đầu số mobile VN 3/5/7/8/9", () => {
    expect(toLocalPhone("900000001")).toBe("0900000001")
    expect(toLocalPhone("901234567")).toBe("0901234567")
  })

  it("KHÔNG đụng số 12 chữ số 84xxxxxxxxxx (không phải số di động)", () => {
    // 84 + 8800000056 (10 chữ số) = 12 chữ số → không khớp mẫu 11 số → giữ nguyên
    expect(toLocalPhone("848800000056")).toBe("848800000056")
  })
})

describe("formatPhone — nhóm 4-3-3 + chuẩn hoá 84→0", () => {
  it("84xxx hiển thị như 0xxx có nhóm", () => {
    expect(formatPhone("84900000001")).toBe("0900 000 001")
  })

  it("+84xxx hiển thị như 0xxx có nhóm", () => {
    expect(formatPhone("+84900000001")).toBe("0900 000 001")
  })

  it("0xxx (Danh bạ) giữ nguyên định dạng nhóm", () => {
    expect(formatPhone("0900000001")).toBe("0900 000 001")
  })

  it("84xxx và 0xxx CÙNG số → hiển thị GIỐNG NHAU (đồng nhất giữa các màn hình)", () => {
    expect(formatPhone("84900000001")).toBe(formatPhone("0900000001"))
  })

  it("rỗng / null / undefined → chuỗi rỗng", () => {
    expect(formatPhone("")).toBe("")
    expect(formatPhone(null)).toBe("")
    expect(formatPhone(undefined)).toBe("")
  })

  it("số không khớp mẫu VN → trả nguyên gốc (không format)", () => {
    expect(formatPhone("123")).toBe("123")
    expect(formatPhone("848800000056")).toBe("848800000056")
  })
})

describe("maskPhone — 84xxx và 0xxx che giống nhau (2 chữ số cuối)", () => {
  it("84xxx → xxx-xxx-**<2 cuối>, khớp với 0xxx cùng số", () => {
    expect(maskPhone("84900000001")).toBe("xxx-xxx-**01")
    expect(maskPhone("84900000001")).toBe(maskPhone("0900000001"))
  })
})
