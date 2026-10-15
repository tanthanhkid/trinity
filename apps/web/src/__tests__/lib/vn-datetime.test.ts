import { describe, expect, it } from "vitest"
import {
  autoMaskVnDateTime, buildMonthGrid, joinLocalDateTime, localToVnDateTime,
  parseVnDateTime, splitLocalDateTime, vnLocalToIso,
} from "@/lib/vn-datetime"

describe("vn-datetime", () => {
  it("đổi qua lại YYYY-MM-DDTHH:mm ↔ dd/mm/yyyy HH:mm", () => {
    expect(localToVnDateTime("2026-10-03T09:05")).toBe("03/10/2026 09:05")
    expect(localToVnDateTime("")).toBe("")
    expect(localToVnDateTime("rác")).toBe("")
    const p = splitLocalDateTime("2026-10-03T09:05")!
    expect(joinLocalDateTime(p)).toBe("2026-10-03T09:05")
  })

  it("mask khi gõ chèn / khoảng trắng :", () => {
    expect(autoMaskVnDateTime("0310202609")).toBe("03/10/2026 09")
    expect(autoMaskVnDateTime("031020260905")).toBe("03/10/2026 09:05")
    expect(autoMaskVnDateTime("03/10/2026 09:05xx")).toBe("03/10/2026 09:05")
    expect(autoMaskVnDateTime("0")).toBe("0")
  })

  it("parse hợp lệ → local string; rỗng → ''; dở dang/không có thật → undefined", () => {
    expect(parseVnDateTime("03/10/2026 09:05")).toBe("2026-10-03T09:05")
    expect(parseVnDateTime("  ")).toBe("")
    expect(parseVnDateTime("03/10/2026 09")).toBeUndefined()
    expect(parseVnDateTime("31/02/2026 09:05")).toBeUndefined()
    expect(parseVnDateTime("03/10/2026 24:00")).toBeUndefined()
    expect(parseVnDateTime("03/10/2026 12:60")).toBeUndefined()
    expect(parseVnDateTime("29/02/2024 00:00")).toBe("2024-02-29T00:00")
  })

  it("lưới tháng 6x7, tuần bắt đầu Thứ Hai", () => {
    const g = buildMonthGrid(2026, 10) // 01/10/2026 là Thứ Năm
    expect(g).toHaveLength(6)
    expect(g.every((r) => r.length === 7)).toBe(true)
    expect(g[0][3]).toMatchObject({ day: 1, month: 10, inMonth: true })
    expect(g[0][0]).toMatchObject({ day: 28, month: 9, inMonth: false })
  })

  it("giờ VN → ISO UTC", () => {
    expect(vnLocalToIso("2026-10-03T09:05")).toBe("2026-10-03T02:05:00.000Z")
  })
})

describe("isoToVnLocal", () => {
  it("đổi UTC sang giờ VN, kể cả khi qua ngày", async () => {
    const { isoToVnLocal, vnLocalToIso } = await import("@/lib/vn-datetime")
    expect(isoToVnLocal("2026-10-04T20:00:00.000Z")).toBe("2026-10-05T03:00")
    expect(isoToVnLocal(vnLocalToIso("2026-10-05T03:00"))).toBe("2026-10-05T03:00")
    expect(isoToVnLocal(null)).toBe("")
  })
})
