import { describe, expect, it } from "vitest"
import { matchRouteParams } from "@/lib/route-params"

describe("matchRouteParams", () => {
  it("lấy đoạn động theo mẫu", () => {
    expect(matchRouteParams("/contacts/:id", "/contacts/123")).toEqual({ id: "123" })
    expect(matchRouteParams("/x/:objectKey/v/:viewKey", "/x/khach/v/kanban1")).toEqual({
      objectKey: "khach",
      viewKey: "kanban1",
    })
  })
  it("không khớp khi khác độ dài hoặc khác đoạn cố định", () => {
    expect(matchRouteParams("/contacts/:id", "/contacts")).toBeNull()
    expect(matchRouteParams("/contacts/:id", "/projects/1")).toBeNull()
    expect(matchRouteParams("/x/:objectKey/new", "/x/khach/v/1")).toBeNull()
  })
  it("bỏ qua dấu gạch chéo cuối", () => {
    expect(matchRouteParams("/invite/:token", "/invite/TOKEN-xyz/")).toEqual({ token: "TOKEN-xyz" })
  })
})
