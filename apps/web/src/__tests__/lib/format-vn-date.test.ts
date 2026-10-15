import { describe, expect, it } from "vitest"
import { autoMaskVnDate, parseVnDate, isoToVnDate } from "@/lib/format"

describe("autoMaskVnDate — gõ từng phím", () => {
  it("gõ 2 chữ số → trả nguyên, chưa thêm /", () => {
    expect(autoMaskVnDate("10")).toBe("10")
  })

  it("gõ 3 chữ số → chèn / sau 2", () => {
    expect(autoMaskVnDate("105")).toBe("10/5")
  })

  it("gõ 4 chữ số → DD/MM", () => {
    expect(autoMaskVnDate("1005")).toBe("10/05")
  })

  it("gõ đủ 8 chữ số → DD/MM/YYYY", () => {
    expect(autoMaskVnDate("10052026")).toBe("10/05/2026")
  })

  it("cắt bỏ chữ số dư thừa sau 8", () => {
    expect(autoMaskVnDate("100520261234")).toBe("10/05/2026")
  })

  it("strip ký tự không phải số khi gõ", () => {
    expect(autoMaskVnDate("10-05-2026")).toBe("10/05/2026")
  })
})

describe("autoMaskVnDate — chỉnh sửa trong input (edit mode)", () => {
  it("user xoá phần dd → không reset về 00, giữ cấu trúc", () => {
    // "/03/2026": dd rỗng → giữ nguyên, user gõ tiếp
    expect(autoMaskVnDate("/03/2026")).toBe("/03/2026")
  })

  it("user xoá phần mm → không reset về 00, giữ cấu trúc", () => {
    // "15//2026": mm rỗng → giữ nguyên, user gõ tiếp
    expect(autoMaskVnDate("15//2026")).toBe("15//2026")
  })

  it("user đang gõ dở tháng 1 chữ số → KHÔNG pad 00 (giữ nguyên để gõ tiếp)", () => {
    // "15/0/2026": mm="0" → giữ "0", không pad "00" → user gõ "3" → "15/03/2026"
    expect(autoMaskVnDate("15/0/2026")).toBe("15/0/2026")
  })

  it("user đang gõ dở ngày 1 chữ số → KHÔNG pad 00", () => {
    // "1/03/2026": dd="1" → giữ "1", không pad "01" → user gõ "5" → "15/03/2026"
    expect(autoMaskVnDate("1/03/2026")).toBe("1/03/2026")
  })

  it("ngày hợp lệ đầy đủ không thay đổi", () => {
    expect(autoMaskVnDate("15/03/2026")).toBe("15/03/2026")
  })
})

describe("autoMaskVnDate — paste có dấu /", () => {
  it("paste 1/5/2026 → giữ nguyên (không pad — tránh bug '00' khi edit)", () => {
    // Không pad "1" → "01" vì không thể phân biệt paste vs đang gõ dở
    // User thấy "1/5/2026" và có thể hoàn thiện hoặc submit (parseVnDate reject cho đến khi đủ 2+2+4 chữ)
    expect(autoMaskVnDate("1/5/2026")).toBe("1/5/2026")
  })

  it("paste 1/5/26 → giữ cấu trúc, không pad, không strip", () => {
    expect(autoMaskVnDate("1/5/26")).toBe("1/5/26")
  })

  it("paste 01/05/2026 → giữ nguyên (đã đúng format)", () => {
    expect(autoMaskVnDate("01/05/2026")).toBe("01/05/2026")
  })

  it("paste 31/12/2025 → giữ nguyên", () => {
    expect(autoMaskVnDate("31/12/2025")).toBe("31/12/2025")
  })
})

describe("parseVnDate — validate", () => {
  it("ngày hợp lệ → trả ISO", () => {
    expect(parseVnDate("10/05/2026")).toBe("2026-05-10")
  })

  it("partial < 10 ký tự → undefined", () => {
    expect(parseVnDate("10/05")).toBeUndefined()
  })

  it("31/02/2026 → undefined (ngày không tồn tại)", () => {
    expect(parseVnDate("31/02/2026")).toBeUndefined()
  })

  it("29/02/2024 → ok (năm nhuận)", () => {
    expect(parseVnDate("29/02/2024")).toBe("2024-02-29")
  })

  it("29/02/2023 → undefined (không phải năm nhuận)", () => {
    expect(parseVnDate("29/02/2023")).toBeUndefined()
  })

  it("rỗng → chuỗi rỗng (partial, không phải invalid)", () => {
    expect(parseVnDate("")).toBe("")
  })
})

describe("isoToVnDate", () => {
  it("2026-05-10 → 10/05/2026", () => {
    expect(isoToVnDate("2026-05-10")).toBe("10/05/2026")
  })

  it("null → chuỗi rỗng", () => {
    expect(isoToVnDate(null)).toBe("")
  })

  it("undefined → chuỗi rỗng", () => {
    expect(isoToVnDate(undefined)).toBe("")
  })

  it("chuỗi rác → chuỗi rỗng", () => {
    expect(isoToVnDate("not-a-date")).toBe("")
  })
})
