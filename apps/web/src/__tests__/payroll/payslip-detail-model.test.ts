import { describe, expect, it } from "vitest"
import type { PayslipRow } from "@/app/(dashboard)/payroll/_components/payroll-payslips-shared"
import {
  changedKeys, formFromRow, payloadFromForm, projectTotals, totalsFromForm,
} from "@/app/(dashboard)/payroll/_components/payroll-payslip-form"
import {
  HIDDEN_MASK, buildCalcText, buildMineGroups, maskAmount, minePdfName, mineStatusHint,
} from "@/app/(dashboard)/payroll/_components/payroll-mine-model"
import { readHidden, resetHiddenMemory, toggleHidden } from "@/app/(dashboard)/payroll/_components/payroll-mine-hide"

function row(over: Partial<PayslipRow> = {}): PayslipRow {
  return {
    id: 1, employee_id: 2, month: "2026-11", base_salary: "9000000", deductions: "0", total: "10000000",
    working_days: 23, standard_working_days: 24, base_salary_actual: "8625000", training_days: null,
    training_salary: "0", probation_allowance: "0", sales_personal: "0", bonus_rate: null, kpi_percent: null,
    bonus_sales_personal: "1200000", sales_team: "0", bonus_cskh_team: "0", bonus_milestone: "500000",
    bonus_referral: "0", holiday_bonus: "0", advances: "1000000", notes: null, cong_lcb: "8625000",
    cong_thuong: "1700000", tong_luong: "10325000", insurance_total: "525000", insurance_base: "5000000",
    phu_cap_xang_xe: "4000000", tax_total: "0", tong_giam_tru: "1525000", don_gia_ngay_cong: "375000",
    bonus_sales_personal_suggested: "0", status: "draft",
    employee: { id: 2, user_id: 3, position: "", team_id: null, user: { full_name: "A", email: "a@x" } },
    ...over,
  } as PayslipRow
}

describe("form phiếu lương", () => {
  it("dựng form từ dòng và payload khớp PATCH cũ", () => {
    const f = formFromRow(row())
    expect(f.working_days).toBe("23")
    const p = payloadFromForm(f)
    expect(p.base_salary).toBe("9000000")
    expect(p.training_days).toBeNull()
    expect(p.standard_working_days).toBe(24)
  })
  it("tính tạm tính giống BE: thực lĩnh LCB + thưởng", () => {
    const t = totalsFromForm(formFromRow(row()))
    expect(t.baseActual).toBe(8625000)
    expect(t.congThuong).toBe(1700000)
    expect(t.tongLuong).toBe(10325000)
  })
  it("chưa sửa thì giữ đúng số máy chủ; sửa thưởng thì cộng chênh lệch", () => {
    const r = row()
    const saved = formFromRow(r)
    expect(projectTotals(r, saved, saved)).toEqual({ net: 10000000, gross: 10325000, ded: 1525000 })
    const next = { ...saved, bonus_milestone: "700000", advances: "1500000" }
    const p = projectTotals(r, next, saved)
    expect(p.gross).toBe(10525000)
    expect(p.ded).toBe(2025000)
    expect(p.net).toBe(10000000 + 200000 - 500000)
    expect(changedKeys(next, saved).sort()).toEqual(["advances", "bonus_milestone"])
  })
  it("thực nhận không âm", () => {
    const r = row({ total: "100000" })
    const saved = formFromRow(r)
    expect(projectTotals(r, { ...saved, advances: "9000000" }, saved).net).toBe(0)
  })
})

describe("phiếu của tôi", () => {
  it("nhóm thu nhập chỉ có khoản > 0, khấu trừ có BH + thuế + tạm ứng", () => {
    const [inc, ded] = buildMineGroups(row())
    expect(inc.rows.map((x) => x.label)).toEqual(["Lương theo công", "Thưởng doanh số", "Thưởng mốc"])
    expect(inc.sum).toBe((10325000).toLocaleString("vi-VN"))
    expect(ded.rows.map((x) => x.label)).toEqual(["Bảo hiểm xã hội, y tế, thất nghiệp", "Thuế thu nhập cá nhân", "Tạm ứng đã nhận"])
    expect(ded.rows[1].sub).toBe("Chưa tới mức chịu thuế")
  })
  it("lời nhắn theo trạng thái", () => {
    expect(mineStatusHint(row({ status: "paid" }))).toMatch(/đã trả/)
    expect(mineStatusHint(row({ status: "pending_tl" }))).toMatch(/chờ duyệt/)
  })
})

describe("Phiếu của tôi: ẩn số + tải PDF", () => {
  it("ẩn số: thay bằng sáu chấm, không lộ số nào trong cách tính", () => {
    expect(maskAmount("10.325.000", true)).toBe(HIDDEN_MASK)
    expect(maskAmount("10.325.000", false)).toBe("10.325.000")
    expect(buildCalcText(row(), true)).toBe("Số tiền đang ẩn.")
    expect(buildCalcText(row(), true)).not.toMatch(/\d/)
  })

  it("cách tính khi hiện số: theo công hoặc đủ công", () => {
    expect(buildCalcText(row())).toBe("9.000.000 ₫ × 23 / 24 ngày = 8.625.000 ₫")
    expect(buildCalcText(row({ working_days: null }))).toBe("9.000.000 ₫ × đủ công = 8.625.000 ₫")
  })

  it("tên tệp chỉ giữ số và gạch nối", () => {
    expect(minePdfName("2026-11")).toBe("phieu-luong-2026-11.pdf")
    expect(minePdfName('20"26-11\n')).toBe("phieu-luong-2026-11.pdf")
  })

  it("công tắc nhớ theo thiết bị, mặc định hiện, lưu trữ hỏng vẫn không văng", () => {
    const real = Object.getOwnPropertyDescriptor(window, "localStorage")
    const stub = (get: () => string | null) =>
      Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: get } })
    try {
      stub(() => null)
      expect(readHidden()).toBe(false)
      stub(() => "1")
      expect(readHidden()).toBe(true)
      stub(() => {
        throw new Error("blocked")
      })
      expect(readHidden()).toBe(false)
    } finally {
      if (real) Object.defineProperty(window, "localStorage", real)
    }
  })

  it("ghi localStorage hỏng (đầy/riêng tư) thì công tắc vẫn đổi trong phiên", () => {
    const real = Object.getOwnPropertyDescriptor(window, "localStorage")
    const store = new Map<string, string>()
    const stub = (failSet: boolean) =>
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: {
          getItem: (k: string) => store.get(k) ?? null,
          setItem: (k: string, v: string) => {
            if (failSet) throw new Error("QuotaExceededError")
            store.set(k, v)
          },
        },
      })
    try {
      resetHiddenMemory()
      stub(true)
      expect(readHidden()).toBe(false)
      toggleHidden()
      expect(readHidden()).toBe(true)
      toggleHidden()
      expect(readHidden()).toBe(false)
      stub(false)
      toggleHidden()
      expect(readHidden()).toBe(true)
      expect(store.get("trinity.payroll.hide-amounts")).toBe("1")
    } finally {
      resetHiddenMemory()
      if (real) Object.defineProperty(window, "localStorage", real)
    }
  })
})
