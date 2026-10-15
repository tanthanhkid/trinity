import { describe, expect, it } from "vitest"
import { metricItems } from "../social-metrics"

describe("dòng số liệu bài", () => {
  it("Facebook: cảm xúc + chia sẻ; bài chữ không có lượt xem", () => {
    expect(metricItems({ views: null, reactions: 3, comments: 1, shares: 0 }, "facebook").map((i) => `${i.value} ${i.label}`)).toEqual(["3 cảm xúc", "1 bình luận", "0 chia sẻ"])
  })
  it("YouTube: lượt xem + thích, không có chia sẻ", () => {
    expect(metricItems({ views: 120, reactions: 7, comments: 2, shares: null }, "youtube").map((i) => `${i.value} ${i.label}`)).toEqual(["120 lượt xem", "7 thích", "2 bình luận"])
  })
  it("không có số nào ⇒ rỗng", () => {
    expect(metricItems({ views: null, reactions: null, comments: null, shares: null }, "facebook")).toEqual([])
  })
})
