import { describe, expect, it } from "vitest"
import { MOBILE_FAB_CLASS } from "@/components/app-shell/mobile-primary"
import { SETTINGS_FAB_SLOT_CLASS } from "@/app/(dashboard)/settings/_components/settings-section-header"

describe("Cài đặt — slot nút chính trên điện thoại", () => {
  it("SETTINGS_FAB_SLOT_CLASS khớp từng class của MOBILE_FAB_CLASS (không lệch khi nền tảng đổi)", () => {
    const expected = MOBILE_FAB_CLASS.split(/\s+/).map((c) =>
      c.replace("max-sm:", "max-sm:[&_[data-slot=button]]:"),
    )
    expect(SETTINGS_FAB_SLOT_CLASS.split(/\s+/).sort()).toEqual(expected.sort())
  })
})
