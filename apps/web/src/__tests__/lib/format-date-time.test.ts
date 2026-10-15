import { describe, expect, it } from "vitest"
import { formatDate, formatDateTime, formatDateTimeVn, formatTimeVn, vnDateKey } from "@/lib/format"

describe("formatDate", () => {
  it("trả '—' khi null", () => {
    expect(formatDate(null)).toBe("—")
  })

  it("trả '—' khi undefined", () => {
    expect(formatDate(undefined)).toBe("—")
  })

  it("trả '—' khi chuỗi rỗng", () => {
    expect(formatDate("")).toBe("—")
  })

  it("trả '—' khi chuỗi không hợp lệ", () => {
    expect(formatDate("not-a-date")).toBe("—")
  })

  it("format ISO string → dd/MM/yyyy (vi-VN 2-digit)", () => {
    // 2026-05-10 UTC — đảm bảo format đúng, không phụ thuộc locale browser
    const result = formatDate("2026-05-10T00:00:00.000Z")
    // Kết quả phụ thuộc vào timezone môi trường test, chỉ kiểm tra pattern
    expect(result).toMatch(/\d{2}\/\d{2}\/\d{4}/)
  })

  it("chấp nhận Date object", () => {
    const d = new Date("2026-01-15T12:00:00Z")
    const result = formatDate(d)
    expect(result).not.toBe("—")
    expect(result).toMatch(/\d{2}\/\d{2}\/\d{4}/)
  })

  it("không trả thừa giờ:phút:giây", () => {
    const result = formatDate("2026-05-10T09:30:00.000Z")
    // formatDate chỉ trả ngày, không có thành phần giờ
    expect(result).not.toMatch(/\d{2}:\d{2}/)
  })
})

describe("formatDateTime", () => {
  it("trả '—' khi null", () => {
    expect(formatDateTime(null)).toBe("—")
  })

  it("trả '—' khi undefined", () => {
    expect(formatDateTime(undefined)).toBe("—")
  })

  it("trả '—' khi chuỗi rỗng", () => {
    expect(formatDateTime("")).toBe("—")
  })

  it("trả '—' khi chuỗi không hợp lệ", () => {
    expect(formatDateTime("not-a-date")).toBe("—")
  })

  it("format ISO string → dd/MM/yyyy HH:mm (không có giây, không có dấu phẩy)", () => {
    const result = formatDateTime("2026-05-10T09:30:00.000Z")
    // Có cả ngày và giờ:phút
    expect(result).toMatch(/\d{2}\/\d{2}\/\d{4}/)
    expect(result).toMatch(/\d{2}:\d{2}/)
    // KHÔNG có giây (phần HH:mm:ss sẽ có :\d{2} thứ 2)
    expect(result).not.toMatch(/\d{2}:\d{2}:\d{2}/)
  })

  it("chấp nhận Date object", () => {
    const d = new Date("2026-01-15T12:00:00Z")
    const result = formatDateTime(d)
    expect(result).not.toBe("—")
    expect(result).toMatch(/\d{2}\/\d{2}\/\d{4}/)
  })

  it("output không chứa dấu phẩy giữa ngày và giờ", () => {
    // Bug trước: toLocaleString('vi-VN') không options → 'dd/MM/yyyy, HH:mm:ss'
    const result = formatDateTime("2026-05-10T09:30:00.000Z")
    expect(result).not.toContain(", ")
  })
})

describe("formatDateTimeVn", () => {
  it("trả '—' khi null", () => {
    expect(formatDateTimeVn(null)).toBe("—")
  })

  it("trả '—' khi undefined", () => {
    expect(formatDateTimeVn(undefined)).toBe("—")
  })

  it("trả '—' khi chuỗi rỗng", () => {
    expect(formatDateTimeVn("")).toBe("—")
  })

  it("trả '—' khi chuỗi không hợp lệ", () => {
    expect(formatDateTimeVn("not-a-date")).toBe("—")
  })

  it("format ISO string → HH:mm:ss DD/MM/YYYY có giây (giờ VN +7)", () => {
    // 2026-06-04T02:05:37Z = 09:05:37 ngày 04/06/2026 giờ VN (+07:00)
    const result = formatDateTimeVn("2026-06-04T02:05:37.000Z")
    expect(result).toBe("09:05:37 04/06/2026")
  })

  it("luôn có giây — pattern HH:mm:ss DD/MM/YYYY", () => {
    const result = formatDateTimeVn("2026-01-15T12:00:00Z")
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2} \d{2}\/\d{2}\/\d{4}$/)
  })

  it("chấp nhận Date object", () => {
    const d = new Date("2026-06-04T02:05:37Z")
    expect(formatDateTimeVn(d)).toBe("09:05:37 04/06/2026")
  })

  it("output không chứa dấu phẩy", () => {
    const result = formatDateTimeVn("2026-06-04T02:05:37.000Z")
    expect(result).not.toContain(",")
  })
})

// dải phân cách ngày trong hội thoại cần so sánh "cùng
// ngày lịch VN" chính xác, không lệch theo timezone máy client.
describe("vnDateKey", () => {
  it("trả '' khi null/undefined/rỗng", () => {
    expect(vnDateKey(null)).toBe("")
    expect(vnDateKey(undefined)).toBe("")
    expect(vnDateKey("")).toBe("")
  })

  it("trả '' khi chuỗi không hợp lệ", () => {
    expect(vnDateKey("not-a-date")).toBe("")
  })

  it("format YYYY-MM-DD theo giờ VN", () => {
    // 09:05 ngày 04/06/2026 giờ VN
    expect(vnDateKey("2026-06-04T02:05:37.000Z")).toBe("2026-06-04")
  })

  it("lệch NGÀY qua mốc nửa đêm giờ VN — KHÔNG dùng ngày lịch UTC", () => {
    // 2026-06-03T18:00:00Z = 01:00 ngày 04/06/2026 giờ VN (+07) — UTC vẫn
    // là 03/06, nhưng theo lịch VN đã sang 04/06. Đây chính là bug lớp
    // "lệch ngày quanh 00:00-06:59 giờ VN" đã ghi trong quy ước dự án.
    expect(vnDateKey("2026-06-03T18:00:00.000Z")).toBe("2026-06-04")
  })

  it("2 thời điểm khác giờ UTC nhưng CÙNG ngày VN → cùng key", () => {
    const morning = vnDateKey("2026-06-04T00:00:01.000Z") // 07:00:01 VN
    const evening = vnDateKey("2026-06-04T16:59:59.000Z") // 23:59:59 VN
    expect(morning).toBe("2026-06-04")
    expect(evening).toBe("2026-06-04")
  })

  it("chấp nhận Date object", () => {
    const d = new Date("2026-06-04T02:05:37Z")
    expect(vnDateKey(d)).toBe("2026-06-04")
  })
})

describe("formatTimeVn", () => {
  it("trả '' khi null/undefined/rỗng", () => {
    expect(formatTimeVn(null)).toBe("")
    expect(formatTimeVn(undefined)).toBe("")
    expect(formatTimeVn("")).toBe("")
  })

  it("trả '' khi chuỗi không hợp lệ", () => {
    expect(formatTimeVn("not-a-date")).toBe("")
  })

  it("format HH:mm theo giờ VN (KHÔNG có giây)", () => {
    expect(formatTimeVn("2026-06-04T02:05:37.000Z")).toBe("09:05")
  })

  it("chấp nhận Date object", () => {
    const d = new Date("2026-06-04T02:05:37Z")
    expect(formatTimeVn(d)).toBe("09:05")
  })
})
