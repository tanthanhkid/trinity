/**
 * Thực thể tuỳ biến — phần THUẦN của FE: menu động, breadcrumb, bộ lọc → JSON, định dạng giá trị, đổi ngày giờ.
 */
import { describe, expect, it } from "vitest"
import type { Grants } from "@trinity/rbac"
import { menuItems } from "@/components/nav-config"
import { isItemVisible } from "@/components/nav-visibility"
import { buildCustomMenuItems, withCustomObjectItems } from "@/components/app-shell/menu-custom"
import { resolveBreadcrumb, resolveCustomBreadcrumb } from "@/lib/nav-breadcrumb"
import { isoToVnLocal, vnLocalToIso } from "@/lib/custom-objects/datetime"
import { formatNumberVn, formatScalar } from "@/lib/custom-objects/format-value"
import { CHOICE_COLOR_CLASS, resolveChoiceColor } from "@/lib/custom-objects/field-meta"
import { CUSTOM_ICON_MAP, customIcon } from "@/lib/custom-objects/icons"
import { resolveActiveHref } from "@/components/app-shell/nav-active"
import { CustomFieldValue } from "@/components/custom-objects/custom-field-value"
import { blobErrorMessage } from "@/hooks/custom-objects/use-custom-objects"
import { buildFilterParam } from "@/components/custom-objects/custom-records-filters"
import { slugifyObjectKey } from "@/app/(dashboard)/settings/_components/custom-objects/object-form-dialog"
import type { CustomFieldDef, CustomNavItem, CustomObjectDef } from "@/types/custom-objects"

const nav: CustomNavItem[] = [
  { key: "khach_hang", label: "Khách hàng", label_plural: "Khách hàng", icon: "graduation-cap", nav_order: 1 },
  { key: "hoa_don", label: "Hoá đơn", label_plural: "Hoá đơn", icon: "receipt", nav_order: 2 },
]
const field = (key: string, type: CustomFieldDef["type"], extra: Partial<CustomFieldDef> = {}): CustomFieldDef => ({
  id: 1, key, label: key, type, required: false, is_unique: false, is_title: false, show_in_list: true, sort_order: 0, options: {}, help_text: null, ...extra,
})

describe("menu động — mỗi tính năng tuỳ biến là MỘT mục cấp 1", () => {
  it("không có tính năng nào → không thêm mục", () => {
    expect(buildCustomMenuItems([])).toEqual([])
    expect(withCustomObjectItems(menuItems, [])).toBe(menuItems)
  })

  it("phẳng: không còn nhóm; các mục đứng NGAY TRƯỚC Cài đặt, đúng thứ tự, trỏ /x/<key>, cần custom_records.view", () => {
    const items = withCustomObjectItems(menuItems, nav)
    const at = items.findIndex((m) => m.key === "settings")
    expect(items[at - 2].key).toBe("custom_khach_hang")
    expect(items[at - 1].key).toBe("custom_hoa_don")
    expect(items.some((m) => m.key === "custom_objects")).toBe(false)
    const mine = items.filter((m) => m.key.startsWith("custom_"))
    expect(mine.map((m) => m.href)).toEqual(["/x/khach_hang", "/x/hoa_don"])
    expect(mine.every((m) => m.children === undefined && m.permission === "custom_records.view")).toBe(true)
    expect(items.length).toBe(menuItems.length + 2)
    expect(menuItems.some((m) => m.key.startsWith("custom_"))).toBe(false) // không đổi mảng gốc
  })

  it("không có mục 'settings' → thêm vào cuối", () => {
    const out = withCustomObjectItems([], nav)
    expect(out.map((m) => m.key)).toEqual(["custom_khach_hang", "custom_hoa_don"])
  })

  it("hiển thị theo QUYỀN (isItemVisible): thiếu custom_records.view → ẩn; manage ≠ view; có view → hiện", () => {
    const [m] = buildCustomMenuItems(nav)
    expect(isItemVisible(m, {} as Grants)).toBe(false)
    expect(isItemVisible(m, { "custom_objects.manage": true } as Grants)).toBe(false)
    expect(isItemVisible(m, { "custom_records.view": "own" } as Grants)).toBe(true)
  })

  it("mục đang ở /x/<key>/<id> được tô active (ranh giới đường dẫn, không khớp nhầm /x/khach_hang2)", () => {
    const hrefs = buildCustomMenuItems(nav).map((m) => m.href as string)
    expect(resolveActiveHref("/x/khach_hang/12", hrefs)).toBe("/x/khach_hang")
    expect(resolveActiveHref("/x/khach_hang", hrefs)).toBe("/x/khach_hang")
    expect(resolveActiveHref("/x/khach_hang2", hrefs)).toBeNull()
  })

  it("icon lạ → icon mặc định; mọi tên trong whitelist có component", () => {
    expect(customIcon("khong-co")).toBe(customIcon(null))
    for (const n of Object.keys(CUSTOM_ICON_MAP)) expect(customIcon(n)).toBeTruthy()
  })
})

describe("breadcrumb /x/<key>", () => {
  it("lấy tên số nhiều từ menu tuỳ biến; chưa tải → 'Tuỳ biến'; không phải /x → null", () => {
    expect(resolveCustomBreadcrumb("/x/khach_hang/12", nav)).toEqual({ title: "Khách hàng" })
    expect(resolveCustomBreadcrumb("/x/khac", nav)).toEqual({ title: "Tuỳ biến" })
    expect(resolveCustomBreadcrumb("/x/khach_hang", undefined)?.title).toBe("Tuỳ biến")
    expect(resolveCustomBreadcrumb("/xx/khach_hang", nav)).toBeNull()
    expect(resolveCustomBreadcrumb("/dashboard", nav)).toBeNull()
    expect(resolveBreadcrumb("/dashboard").title).toBeTruthy()
  })

  it("bảng có cả trang mặc định lẫn màn xem: mỗi đường mở ghi ĐÚNG tên của nó", () => {
    const multi = [
      { key: "lich_hen", label: "Lịch tuần", label_plural: "Lịch tuần", icon: null, nav_order: 1, href: "/x/lich_hen/v/lich_tuan", menu_key: "lich_hen__lich_tuan" },
      { key: "lich_hen", label: "Lịch hẹn", label_plural: "Lịch hẹn", icon: null, nav_order: 2, href: "/x/lich_hen", menu_key: "lich_hen" },
    ] as CustomNavItem[]
    expect(resolveCustomBreadcrumb("/x/lich_hen", multi)?.title).toBe("Lịch hẹn")
    expect(resolveCustomBreadcrumb("/x/lich_hen/16", multi)?.title).toBe("Lịch hẹn")
    expect(resolveCustomBreadcrumb("/x/lich_hen/v/lich_tuan", multi)?.title).toBe("Lịch tuần")
    // Bảng không có mục riêng trong menu (chỉ có màn xem): không mượn tên màn xem cho trang bảng.
    expect(resolveCustomBreadcrumb("/x/lich_hen", [multi[0]])?.title).toBe("Tuỳ biến")
  })
})

describe("buildFilterParam", () => {
  const def = { fields: [field("tt", "select"), field("diem", "number"), field("ngay", "date"), field("gio", "datetime"), field("xong", "boolean"), field("ph", "relation", { options: { target_object_id: 2 } }), field("sdt", "phone"), field("ten", "text")] } as unknown as CustomObjectDef

  it("không có điều kiện → undefined; bỏ ô rỗng", () => {
    expect(buildFilterParam(def, {})).toBeUndefined()
    expect(buildFilterParam(def, { tt: undefined, diem: { min: "", max: "" }, ngay: {} })).toBeUndefined()
  })

  it("dựng JSON đúng dạng BE: select/khoảng số/ngày/ngày giờ giờ VN/boolean/liên kết", () => {
    const p = JSON.parse(buildFilterParam(def, {
      tt: "hoc", diem: { min: "5", max: "9.5" }, ngay: { from: "2025-01-01" }, gio: { from: "2025-01-01", to: "2025-01-02" }, xong: "false", ph: 7,
    }) as string)
    expect(p).toEqual({
      tt: "hoc", diem: { min: 5, max: 9.5 }, ngay: { from: "2025-01-01" },
      gio: { from: "2025-01-01T00:00:00+07:00", to: "2025-01-02T23:59:59.999+07:00" }, xong: false, ph: 7,
    })
  })

  it("KHÔNG đưa trường không lọc được (phone/text) vào JSON — chống dò", () => {
    expect(buildFilterParam(def, { sdt: "0900", ten: "x" })).toBeUndefined()
  })
})

describe("định dạng giá trị & ngày giờ", () => {
  it("null/rỗng → '—' TRƯỚC khi format; tiền, %, ngày, bool", () => {
    expect(formatScalar(field("x", "currency"), null)).toBe("—")
    expect(formatScalar(field("x", "currency"), 0)).toBe("0 ₫")
    expect(formatScalar(field("x", "currency"), 3200000)).toBe("3.200.000 ₫")
    expect(formatScalar(field("x", "percent"), 5)).toBe("5%")
    expect(formatScalar(field("x", "date"), "2025-02-10")).toBe("10/02/2025")
    expect(formatScalar(field("x", "boolean"), false)).toBe("Không")
    expect(formatScalar(field("x", "number"), 12.5)).toBe("12,5")
    expect(formatNumberVn(1234567.891, 2)).toBe("1.234.567,89")
  })

  it("công thức theo format/decimals; null → '—'", () => {
    expect(formatScalar(field("f", "formula", { options: { format: "currency" } }), 9120000)).toBe("9.120.000 ₫")
    expect(formatScalar(field("f", "formula", { options: { format: "number", decimals: 1 } }), 1.25)).toBe("1,3")
    expect(formatScalar(field("f", "formula"), null)).toBe("—")
  })

  it("datetime: ISO UTC ↔ giờ Việt Nam (UTC+7), không phụ thuộc múi giờ máy", () => {
    expect(isoToVnLocal("2025-01-01T18:00:00.000Z")).toBe("2025-01-02T01:00")
    expect(vnLocalToIso("2025-01-02T01:00")).toBe("2025-01-01T18:00:00.000Z")
    expect(isoToVnLocal(undefined)).toBe("")
    expect(vnLocalToIso("rác")).toBeUndefined()
    expect(vnLocalToIso(isoToVnLocal("2025-06-30T17:30:00.000Z"))).toBe("2025-06-30T17:30:00.000Z")
  })
})

describe("slugifyObjectKey", () => {
  it("bỏ dấu tiếng Việt, đúng quy tắc khoá của BE", () => {
    expect(slugifyObjectKey("Khách hàng")).toBe("khach_hang")
    expect(slugifyObjectKey("Đơn giá / buổi")).toBe("don_gia_buoi")
    expect(slugifyObjectKey("2025 năm")).toBe("x_2025_nam")
    expect(slugifyObjectKey("x".repeat(80))).toHaveLength(48)
    expect(/^[a-z][a-z0-9_]{0,47}$/.test(slugifyObjectKey("Hợp đồng #1"))).toBe(true)
  })
})

describe("CustomFieldValue — đường dẫn web", () => {
  it("chỉ http(s) thành liên kết; javascript:/data: chỉ là chữ", async () => {
    const { render } = await import("@testing-library/react")
    const url = field("w", "url")
    const a = render(CustomFieldValue({ field: url, record: { data: { w: "https://example.com/x" }, relations: {} } }))
    expect(a.container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/x")
    const b = render(CustomFieldValue({ field: url, record: { data: { w: "javascript:alert(1)" }, relations: {} } }))
    expect(b.container.querySelector("a")).toBeNull()
    expect(b.container.textContent).toBe("javascript:alert(1)")
  })
})

describe("blobErrorMessage — lỗi xuất CSV (responseType blob) vẫn hiện đúng lý do của BE", () => {
  it("đọc message trong Blob JSON; không phải Blob/JSON → câu chung", async () => {
    const blob = new Blob([JSON.stringify({ statusCode: 403, message: "Bạn không có quyền xuất dữ liệu này" })], { type: "application/json" })
    expect(await blobErrorMessage({ response: { data: blob } })).toBe("Bạn không có quyền xuất dữ liệu này")
    expect(await blobErrorMessage({ response: { data: new Blob(["<html>"]) } })).toMatch(/Không xuất được file/)
    expect(await blobErrorMessage(new Error("x"))).toMatch(/Không xuất được file/)
  })
})

describe("CustomFieldValue — chip/badge trình bày (nội dung chữ không đổi)", () => {
  const rec = (key: string, v: unknown) => ({ data: { [key]: v }, relations: {} })
  const html = async (f: CustomFieldDef, v: unknown) => {
    const { render } = await import("@testing-library/react")
    return render(CustomFieldValue({ field: f, record: rec(f.key, v) })).container
  }

  it("percent: chip amber; 0% nhạt (xám); null → '—' thường", async () => {
    const a = await html(field("p", "percent"), 5)
    expect(a.textContent).toBe("5%")
    expect(a.querySelector("span")?.className).toContain("bg-amber-100")
    expect(a.querySelector("span")?.className).toContain("dark:bg-amber-950")
    expect((await html(field("p", "percent"), 0)).querySelector("span")?.className).toContain("bg-slate-100")
    const n = await html(field("p", "percent"), null)
    expect(n.textContent).toBe("—")
    expect(n.querySelector(".bg-amber-100")).toBeNull()
  })

  it("currency và formula tiền: chip xanh lá, đậm, tabular-nums; 0 vẫn là '0 ₫' (không nuốt)", async () => {
    const c = await html(field("t", "currency"), 1200000)
    expect(c.textContent).toBe("1.200.000 ₫")
    expect(c.querySelector("span")?.className).toContain("bg-emerald-100")
    expect(c.querySelector("span")?.className).toContain("font-semibold")
    expect(c.querySelector("span")?.className).toContain("tabular-nums")
    const f = await html(field("f", "formula", { options: { format: "currency" } }), 500)
    expect(f.querySelector("span")?.className).toContain("bg-emerald-100")
    expect((await html(field("t", "currency"), 0)).textContent).toBe("0 ₫")
    expect((await html(field("t", "currency"), null)).textContent).toBe("—")
  })

  it("boolean: Có xanh / Không xám; number: chip trung tính; date: muted tabular; phone: nội dung giữ nguyên", async () => {
    const y = await html(field("b", "boolean"), true)
    expect(y.textContent).toBe("Có")
    expect(y.querySelector("span")?.className).toContain("bg-emerald-100")
    const no = await html(field("b", "boolean"), false)
    expect(no.textContent).toBe("Không")
    expect(no.querySelector("span")?.className).toContain("bg-slate-100")
    const num = await html(field("n", "number"), 12)
    expect(num.textContent).toBe("12")
    expect(num.querySelector("span")?.className).toContain("bg-muted")
    const d = await html(field("d", "date"), "2026-10-06")
    expect(d.querySelector("span")?.className).toContain("tabular-nums")
    const ph = await html(field("s", "phone"), "0912345***")
    expect(ph.textContent).toBe("0912345***")
    expect(ph.querySelector("span")?.className).toContain("tabular-nums")
  })

  it("select: lựa chọn KHÔNG màu tự gán màu ổn định theo thứ tự (không xám hết); có màu thì giữ; lạ → xám", async () => {
    const choices = [{ value: "a", label: "Chuyển khoản" }, { value: "b", label: "Tiền mặt" }, { value: "c", label: "Đỏ", color: "red" }]
    const f = field("s", "select", { options: { choices } })
    const a = await html(f, "a")
    expect(a.textContent).toBe("Chuyển khoản")
    expect(a.querySelector("span")?.className).toContain("bg-blue-100")
    expect((await html(f, "b")).querySelector("span")?.className).toContain("bg-emerald-100")
    expect((await html(f, "c")).querySelector("span")?.className).toContain("bg-red-100")
    expect((await html(f, "zzz")).querySelector("span")?.className).toContain("bg-slate-100")
    expect(resolveChoiceColor(choices, "a")).toBe(resolveChoiceColor(choices, "a")) // ổn định
    expect(CHOICE_COLOR_CLASS.blue).toContain("dark:")
  })
})
