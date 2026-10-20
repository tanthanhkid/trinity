import { describe, expect, it } from "vitest"
import { viewTabs } from "./view-tabs"

const v = (key: string, type: string) => ({ key, label: key, href: `/x/hs/v/${key}`, type })

describe("viewTabs (#31) — không lặp tab Danh sách, 1 màn thì ẩn", () => {
  it("chưa có view: chỉ Danh sách mặc định (1 tab ⇒ thanh ẩn)", () => {
    expect(viewTabs("hs", []).map((t) => t.key)).toEqual([null])
  })
  it("một view kiểu danh sách: không thêm Danh sách mặc định (1 tab ⇒ thanh ẩn)", () => {
    expect(viewTabs("hs", [v("ds_hs", "list")]).map((t) => t.key)).toEqual(["ds_hs"])
  })
  it("một view kanban: giữ Danh sách mặc định để còn quay về (2 tab ⇒ hiện)", () => {
    expect(viewTabs("hs", [v("bang", "kanban")]).map((t) => t.key)).toEqual([null, "bang"])
  })
  it("danh sách + kanban: giữ cả hai view, không thêm mặc định", () => {
    expect(viewTabs("hs", [v("ds", "list"), v("bang", "kanban")]).map((t) => t.key)).toEqual(["ds", "bang"])
  })
})
