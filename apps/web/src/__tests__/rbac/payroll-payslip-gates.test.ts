/**
 * RBAC quyền + phạm vi — cổng nút phiếu lương theo quyền
 * (thay `canApproveNow`/`canEditPayslip`/`canRemoveFromPeriod` theo vai trò).
 */
import { describe, expect, it } from "vitest"
import { can } from "@/lib/rbac"
import type { Grants } from "@/lib/rbac"
import {
  canApproveNow,
  canEditPayslip,
  canRemoveFromPeriod,
} from "@/app/(dashboard)/payroll/_components/payroll-payslips"

const gate = (g: Grants) => (p: "payroll.approve_team" | "payroll.approve_final") => can(g, p)

describe("canApproveNow", () => {
  it("bước 1 (draft/pending_tl) cần payroll.approve_team", () => {
    const g = gate({ "payroll.approve_team": "team" })
    expect(canApproveNow(g, "draft")).toBe(true)
    expect(canApproveNow(g, "pending_tl")).toBe(true)
    expect(canApproveNow(g, "pending_accountant")).toBe(false)
  })

  it("bước 2 (pending_accountant) cần payroll.approve_final", () => {
    const g = gate({ "payroll.approve_final": true })
    expect(canApproveNow(g, "pending_accountant")).toBe(true)
    expect(canApproveNow(g, "pending_tl")).toBe(false)
  })

  it("phiếu đã duyệt / không quyền → false", () => {
    expect(canApproveNow(gate({ "payroll.approve_team": "all", "payroll.approve_final": true }), "approved")).toBe(false)
    expect(canApproveNow(gate({}), "pending_tl")).toBe(false)
  })
})

describe("canEditPayslip / canRemoveFromPeriod", () => {
  it("sửa: cần payroll.manage và phiếu chưa duyệt/trả", () => {
    expect(canEditPayslip(true, "draft")).toBe(true)
    expect(canEditPayslip(true, "approved")).toBe(false)
    expect(canEditPayslip(true, "paid")).toBe(false)
    expect(canEditPayslip(false, "draft")).toBe(false)
  })

  it("loại khỏi kỳ: phiếu đã duyệt/trả cần thêm payroll.approve_final", () => {
    expect(canRemoveFromPeriod(true, false, "draft")).toBe(true)
    expect(canRemoveFromPeriod(true, false, "approved")).toBe(false)
    expect(canRemoveFromPeriod(true, true, "approved")).toBe(true)
    expect(canRemoveFromPeriod(false, true, "draft")).toBe(false)
  })
})
