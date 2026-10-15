import { describe, expect, it } from "vitest"
import {
  getUserAriaLabel,
  getUserDisplayName,
  getUserEmail,
  getUserEmailTooltip,
} from "@/lib/user-identity"

describe("user identity display", () => {
  it("ưu tiên họ tên đã trim và chỉ dùng email làm tooltip", () => {
    const user = {
      id: 12,
      full_name: "  Nguyễn Văn A  ",
      email: "  a@example.vn  ",
    }

    expect(getUserDisplayName(user)).toBe("Nguyễn Văn A")
    expect(getUserEmailTooltip(user)).toBe("a@example.vn")
    expect(getUserAriaLabel(user)).toBe("Nguyễn Văn A (a@example.vn)")
  })

  it("fallback sang email khi họ tên rỗng và không tooltip lặp lại", () => {
    const user = { id: 13, full_name: "   ", email: " sale@example.vn " }

    expect(getUserDisplayName(user)).toBe("sale@example.vn")
    expect(getUserEmail(user)).toBe("sale@example.vn")
    expect(getUserEmailTooltip(user)).toBeUndefined()
    expect(getUserAriaLabel(user)).toBe("sale@example.vn")
  })

  it("fallback sang id hoặc placeholder khi thiếu cả họ tên và email", () => {
    expect(getUserDisplayName({ id: 14, full_name: "", email: null })).toBe(
      "Người dùng #14",
    )
    expect(getUserDisplayName(null)).toBe("—")
    expect(getUserDisplayName(null, "Đang tải")).toBe("Đang tải")
  })
})
