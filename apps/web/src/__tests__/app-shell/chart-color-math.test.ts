import { describe, expect, it } from "vitest"
import {
  darken,
  lighten,
  LABEL_CHIP_MIX,
} from "@/app/(dashboard)/attendance/_components/leave-analytics-utils"
import { CHART_PALETTE } from "@/components/app-shell/charts/chart-data"

/* =============================================================================
 * 🔴 Khoá một lỗi CHẶN đã gặp.
 *
 * `LEAVE_TYPE_COLORS`/`GENDER_COLORS`/`DEPARTMENT_PALETTE` đổi từ `"#0e9c93"`
 * sang `"var(--color-app-chart-1)"`. Hai hàm `lighten`/`darken` đang làm TOÁN
 * trên chuỗi hex: `parseInt("va", 16)` → `NaN` → trả `"#NaNNaNNaN"`, và SVG tô
 * chuỗi đó thành ĐEN. Không exception, không cảnh báo — 4 biểu đồ khu "Phân
 * tích nghỉ phép" vẽ mặt bên đen sì.
 *
 * Đây là lỗi dạng khó thấy nhất: không phải đổi TÊN mà đổi HÌNH DẠNG GIÁ TRỊ
 * của một hằng dùng chung, trong khi nơi tiêu thụ làm toán trên giá trị đó.
 * ========================================================================== */

describe("lighten/darken phải sống được với CẢ hex LẪN var(--token)", () => {
  it("🔴 var(--token) KHÔNG BAO GIỜ được ra NaN", () => {
    for (const token of CHART_PALETTE) {
      for (const out of [lighten(token, 0.22), darken(token, 0.25)]) {
        expect(out).not.toContain("NaN")
        expect(out).toContain(token) // token được giữ nguyên trong color-mix
      }
    }
  })

  it("var(--token) đẩy phép trộn xuống CSS bằng color-mix", () => {
    expect(lighten("var(--color-app-chart-1)", 0.22)).toBe(
      "color-mix(in srgb, white 22%, var(--color-app-chart-1))",
    )
    expect(darken("var(--color-app-chart-1)", 0.25)).toBe(
      "color-mix(in srgb, black 25%, var(--color-app-chart-1))",
    )
  })

  it("hex vẫn đi đường số học cũ — 0-diff cho call-site truyền hex", () => {
    expect(darken("#0e9c93", 0.25)).toBe("#0b756e")
    expect(lighten("#0e9c93", 0.22)).toBe("#43b2ab")
  })

  it("giá trị CSS khác (chuỗi màu đặt tên, color-mix lồng nhau) cũng không vỡ", () => {
    expect(lighten("currentColor", 0.2)).not.toContain("NaN")
    expect(darken(lighten("var(--x)", 0.2), 0.2)).not.toContain("NaN")
  })
})

describe("🔴 nhãn đè lên khối màu — mảng nền phải đủ sáng cho chữ navy", () => {
  const NAVY = "#101b46"
  const hex = (token: string) => HEX_BY_TOKEN[token]
  const HEX_BY_TOKEN: Record<string, string> = {
    "var(--color-app-chart-1)": "#0e9c93",
    "var(--color-app-chart-2)": "#c47f00",
    "var(--color-app-chart-3)": "#0f62f5",
    "var(--color-app-chart-4)": "#a13bc4",
    "var(--color-app-chart-5)": "#159e57",
    "var(--color-app-chart-6)": "#d13a86",
  }

  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  const lum = (h: string) => {
    const x = h.replace("#", "")
    return (
      0.2126 * lin(parseInt(x.slice(0, 2), 16)) +
      0.7152 * lin(parseInt(x.slice(2, 4), 16)) +
      0.0722 * lin(parseInt(x.slice(4, 6), 16))
    )
  }
  const contrast = (a: string, b: string) => {
    const [la, lb] = [lum(a), lum(b)]
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
  }

  it("navy trên mảng `lighten(màu, LABEL_CHIP_MIX)` đạt AA cho MỌI màu", () => {
    // Không có màu chữ nào đọc được trên chính khối màu (đo tại vị trí chữ,
    // 4/7 màu cả trắng lẫn navy đều dưới 4,5:1) ⇒ phải tách chữ ra bằng mảng
    // nền cục bộ. Test khoá độ sáng tối thiểu của mảng đó.
    for (const token of Object.keys(HEX_BY_TOKEN)) {
      const chip = lighten(hex(token), LABEL_CHIP_MIX)
      expect(contrast(NAVY, chip), `${token} → ${chip}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it("làm nhạt mảng đi thì KHÔNG còn dư địa — giá trị hiện tại không phải tuỳ tiện", () => {
    const tooLight = Math.max(0, LABEL_CHIP_MIX - 0.25)
    const worst = Math.min(
      ...Object.keys(HEX_BY_TOKEN).map((t) => contrast(NAVY, lighten(hex(t), tooLight))),
    )
    expect(worst).toBeLessThan(4.5)
  })
})
