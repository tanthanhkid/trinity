import { describe, expect, it } from "vitest"
import { reminderPresets } from "@/app/(dashboard)/contacts/[id]/_components/reminder-card"
import { stageTone } from "@/app/(dashboard)/contacts/[id]/_components/stage-picker"
import { fieldDisplay, missingCount } from "@/app/(dashboard)/contacts/[id]/_components/info-panel"
import type { ContactData } from "@/app/(dashboard)/contacts/[id]/_components/contact-info-form"

const base: ContactData = {
  id: 1, phone: "0912345678", full_name: "Trần Thu Hà", source_id: null, stage_id: null, contact_status_id: null,
  job_title: null, birthday: null, reminder_at: null, reminder_notes: null, assigned_to: null, team_id: null,
  gender: null, email: null, current_address: null, company_name: null,
}

describe("màn khách «Ánh xanh»", () => {
  it("mốc hẹn gọi lại: trước 16:00 có cả 3 mốc, sau 16:00 bỏ «Chiều nay»", () => {
    const wed = new Date(2026, 10, 25, 10, 0) // thứ Tư
    expect(reminderPresets(wed).map((p) => p.label)).toEqual(["Chiều nay 16:00", "Sáng mai 09:00", "Thứ Hai 09:00"])
    const late = new Date(2026, 10, 25, 17, 0)
    expect(reminderPresets(late).map((p) => p.label)).toEqual(["Sáng mai 09:00", "Thứ Hai 09:00"])
    const monday = reminderPresets(wed)[2].at
    expect(monday.getDay()).toBe(1)
    expect(monday.getDate()).toBe(30)
    expect(monday.getHours()).toBe(9)
  })

  it("thứ Bảy: «Thứ Hai» là 2 ngày sau, Chủ nhật: «Sáng mai» trùng thứ Hai nên chỉ còn một", () => {
    const sat = new Date(2026, 10, 28, 8, 0)
    expect(reminderPresets(sat).at(-1)?.at.getDate()).toBe(30)
    const sun = new Date(2026, 10, 29, 20, 0)
    expect(reminderPresets(sun).map((p) => p.label)).toEqual(["Sáng mai 09:00"])
  })

  it("tông giai đoạn theo mã bền; mã lạ là trung tính", () => {
    expect(stageTone("new")).toBe("new")
    expect(stageTone("follow_up_2")).toBe("consult")
    expect(stageTone("buoc_tu_dat")).toBe("neutral")
    expect(stageTone(null)).toBe("neutral")
  })

  it("đếm thông tin còn thiếu và hiển thị trường", () => {
    expect(missingCount(base)).toBe(5)
    expect(missingCount({ ...base, gender: "nu", job_title: "Kế toán", phone_2: "0901234567" })).toBe(2)
    expect(fieldDisplay("email", { ...base, email: "a@b.vn" })).toBe("a@b.vn")
    expect(fieldDisplay("birthday", base)).toBe("")
    expect(fieldDisplay("birthday", { ...base, birthday: "1990-03-15" })).toBe("15/03/1990")
  })
})
