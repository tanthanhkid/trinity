import { describe, expect, it } from "vitest"
import { defaultSlot, postWhen } from "../social-calendar"

describe("lịch bài đăng", () => {
  it("bài hẹn giờ đặt theo giờ hẹn, bài đăng ngay theo giờ tạo", () => {
    expect(postWhen({ scheduled_at: "2026-10-25T02:00:00Z", created_at: "2026-10-14T05:00:00Z" })).toBe("2026-10-25T02:00:00Z")
    expect(postWhen({ scheduled_at: null, created_at: "2026-10-14T05:00:00Z" })).toBe("2026-10-14T05:00:00Z")
  })
  it("bấm + ở ngày khác hôm nay ⇒ 09:00", () => {
    expect(defaultSlot("2026-10-20", new Date(2026, 9, 14, 15, 10))).toBe("2026-10-20T09:00")
  })
  it("hôm nay sáng sớm ⇒ 09:00; đã trưa ⇒ giờ chẵn kế tiếp sau ≥30 phút", () => {
    expect(defaultSlot("2026-10-14", new Date(2026, 9, 14, 7, 0))).toBe("2026-10-14T09:00")
    expect(defaultSlot("2026-10-14", new Date(2026, 9, 14, 15, 10))).toBe("2026-10-14T16:00")
    expect(defaultSlot("2026-10-14", new Date(2026, 9, 14, 15, 40))).toBe("2026-10-14T17:00")
  })
})
