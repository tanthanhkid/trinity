import { describe, it, expect } from "vitest"
import { resolveBreadcrumb } from "@/lib/nav-breadcrumb"

describe("resolveBreadcrumb", () => {
  it("khớp chính xác trang Tổng quan", () => {
    expect(resolveBreadcrumb("/dashboard")).toEqual({ title: "Tổng quan" })
  })

  it("trang chi tiết khớp về mục cha qua tiền tố", () => {
    expect(resolveBreadcrumb("/contacts/abc")).toEqual({ title: "Khách hàng" })
  })

  it("mục con trả về kèm tiêu đề cha", () => {
    expect(resolveBreadcrumb("/management/employees")).toEqual({
      title: "Quản lý nhân viên",
      parentTitle: "Quản lý",
    })
  })

  it("đường dẫn không khớp → fallback Tổng quan", () => {
    expect(resolveBreadcrumb("/khong-ton-tai")).toEqual({ title: "Tổng quan" })
    expect(resolveBreadcrumb("/")).toEqual({ title: "Tổng quan" })
  })

  it("KHÔNG khớp nhầm tiền tố một phần (/dashboardx)", () => {
    expect(resolveBreadcrumb("/dashboardx")).toEqual({ title: "Tổng quan" })
  })

  it("trang con của menu cha (Quản lý) trả về tiêu đề cha", () => {
    const crumb = resolveBreadcrumb("/management/employees")
    expect(crumb.parentTitle).toBe("Quản lý")
  })

  // Mục chỉ có trong `menu-extra.ts` (không có trong `nav-config.ts`) không được
  // rơi về fallback "Tổng quan".
  it("mục chỉ-có-ở-v2 (Sản phẩm) khớp đúng, không rơi về Tổng quan", () => {
    expect(resolveBreadcrumb("/products")).toEqual({ title: "Sản phẩm" })
  })
})
