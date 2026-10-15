import { describe, expect, it } from "vitest"
import { isPostEditable, movedSchedule, optionsForResubmit } from "@/hooks/use-social"

const now = Date.parse("2026-10-15T03:00:00Z")
const t = (status: string) => ({ status }) as never

describe("sửa / dời bài hẹn giờ", () => {
  it("sửa được khi đang hẹn giờ, còn hơn 1 phút, mọi kênh còn chờ (kênh đã huỷ bỏ qua)", () => {
    expect(isPostEditable({ status: "scheduled", scheduled_at: "2026-10-15T05:00:00Z", targets: [t("queued"), t("cancelled")] }, now)).toBe(true)
    expect(isPostEditable({ status: "scheduled", scheduled_at: "2026-10-15T03:00:30Z", targets: [t("queued")] }, now)).toBe(false)
    expect(isPostEditable({ status: "publishing", scheduled_at: "2026-10-15T05:00:00Z", targets: [t("queued"), t("published")] }, now)).toBe(false)
    expect(isPostEditable({ status: "scheduled", scheduled_at: null, targets: [t("queued")] }, now)).toBe(false)
  })

  it("kéo sang ngày khác giữ nguyên giờ:phút theo giờ Việt Nam", () => {
    expect(movedSchedule("2026-10-15T02:30:00.000Z", "2026-10-18")).toBe("2026-10-18T02:30:00.000Z")
    expect(movedSchedule("2026-10-15T16:15:00.000Z", "2026-10-20")).toBe("2026-10-20T16:15:00.000Z")
  })

  it("gửi lại tuỳ chọn: ảnh thumbnail chuyển thành thumbnail_key, giữ các tuỳ chọn khác", () => {
    expect(optionsForResubmit({ title: "A", thumbnail: { key: "social/t.png", type: "image" } })).toEqual({ title: "A", thumbnail_key: "social/t.png" })
    expect(optionsForResubmit({ privacy_level: "SELF_ONLY" })).toEqual({ privacy_level: "SELF_ONLY" })
    expect(optionsForResubmit(null)).toEqual({})
  })
})
