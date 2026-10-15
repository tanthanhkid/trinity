import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

/** Khoá bất biến: dialog Tạo công việc KHÔNG còn control native. */
describe("ContactCreateTaskDialog dùng control chung", () => {
  const src = readFileSync(
    resolve(__dirname, "../../components/kanban/contact-create-task-dialog.tsx"),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

  it("không còn <select> / datetime-local / VnDateInput native", () => {
    expect(src).not.toMatch(/<select\b/)
    expect(src).not.toMatch(/datetime-local/)
    expect(src).not.toMatch(/<VnDateInput\b/)
  })
  it("dùng InlineSelect cho Bảng/Cột và VnDateTimeInput cho hạn xử lý", () => {
    expect(src).toContain("<InlineSelect")
    expect(src).toContain("<VnDateTimeInput")
    expect(src).toContain("vnLocalToIso(")
  })
})
