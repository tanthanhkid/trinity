/** Gắn thẻ @ — phần thuần: tách thẻ, dò chữ đang gõ sau "@", dán mã, dựng/đọc DOM ô soạn thảo. */
import { describe, expect, it } from "vitest"
import { codesInPastedText, findMentionQuery, mentionCodes, normalizeCode, splitMentions, tagPastedCodes } from "@/lib/refs/mentions"
import { chipBeforeCaret, makeChip, placeCaret, renderValue, replaceWithChip, serialize } from "@/lib/refs/editor-dom"

describe("mã + tách thẻ", () => {
  it("normalizeCode: in hoa, đệm 3 số, bỏ @", () => {
    expect(normalizeCode("sp1")).toBe("SP001")
    expect(normalizeCode("@DH042")).toBe("DH042")
    expect(normalizeCode("ABC1000")).toBe("ABC1000")
    expect(normalizeCode("Nguyễn")).toBeNull()
    expect(normalizeCode("SP0")).toBeNull()
  })
  it("splitMentions: @SP001 thành thẻ; email không phải thẻ; dấu câu sau thẻ giữ nguyên", () => {
    expect(splitMentions("Xem @sp001, thêm @DH002.")).toEqual([
      { kind: "text", text: "Xem " }, { kind: "code", code: "SP001" }, { kind: "text", text: ", thêm " }, { kind: "code", code: "DH002" }, { kind: "text", text: "." },
    ])
    expect(splitMentions("mail a@sp001.vn")).toEqual([{ kind: "text", text: "mail a@sp001.vn" }])
    expect(splitMentions("@SP001abc")).toEqual([{ kind: "text", text: "@SP001abc" }])
    expect(mentionCodes("@SP001 và @sp1 và @KH002")).toEqual(["SP001", "KH002"])
  })
  it("findMentionQuery: @ đầu dòng/sau khoảng trắng, tối đa 3 từ; email không bật", () => {
    expect(findMentionQuery("Xem @Nguy")).toEqual({ query: "Nguy", start: 4 })
    expect(findMentionQuery("@")).toEqual({ query: "", start: 0 })
    expect(findMentionQuery("@SP00")).toEqual({ query: "SP00", start: 0 })
    expect(findMentionQuery("hẹn @Nguyễn Văn")).toEqual({ query: "Nguyễn Văn", start: 4 })
    expect(findMentionQuery("a@b")).toBeNull()
    expect(findMentionQuery("@một hai ba bốn")).toBeNull()
  })
  it("dán: mã trần (≥3 số) thành thẻ, chữ khác giữ nguyên", () => {
    expect(codesInPastedText("SP001, kh2, @DH010 và A1")).toEqual(["SP001", "DH010"])
    expect(tagPastedCodes("Xem SP001 và @DH002")).toBe("Xem @SP001 và @DH002")
    expect(tagPastedCodes("không có mã")).toBe("không có mã")
  })
})

describe("DOM ô soạn thảo", () => {
  it("dựng từ chữ rồi đọc lại đúng nguyên văn (thẻ = @MÃ)", () => {
    const root = document.createElement("div")
    renderValue(root, "Xem @SP001\nrồi thêm @KH002 nhé")
    expect(root.querySelectorAll("[data-code]")).toHaveLength(2)
    expect(serialize(root)).toBe("Xem @SP001\nrồi thêm @KH002 nhé")
  })
  it("tên bản ghi đi qua textContent (không chèn được HTML)", () => {
    const chip = makeChip("SP001", { type: "record", id: 1, ref: "record:1", code: "SP001", title: "<img src=x onerror=alert(1)>", table: "Khách mới", href: "/x/hs/1" })
    expect(chip.querySelector("img")).toBeNull()
    expect(chip.textContent).toContain("<img")
  })
  it("chọn gợi ý: thay '@Ngu' bằng thẻ + khoảng trắng; Backspace ngay sau thẻ nhận ra thẻ", () => {
    const root = document.createElement("div")
    document.body.appendChild(root)
    root.textContent = "Xem @Ngu"
    const node = root.firstChild as Text
    replaceWithChip(node, 4, 8, makeChip("SP001"))
    expect(serialize(root)).toBe("Xem @SP001 ")
    const chip = root.querySelector("[data-code]") as HTMLElement
    placeCaret(root, Array.from(root.childNodes).indexOf(chip) + 1)
    expect(chipBeforeCaret(root)).toBe(chip)
    root.remove()
  })
  it("đọc được <div>/<br> trình duyệt tự chèn khi xuống dòng", () => {
    const root = document.createElement("div")
    root.innerHTML = "a<br>b<div>c</div>"
    expect(serialize(root)).toBe("a\nb\nc")
  })
})

import { linkifyMentions } from "@/components/refs/markdown-with-mentions"

describe("linkifyMentions (Markdown có thẻ @)", () => {
  it("@MÃ thành liên kết nội bộ, chữ khác và email giữ nguyên", () => {
    expect(linkifyMentions("Xem **@kh001** nhé, mail a@kh001.vn")).toBe("Xem **[@KH001](#ref-KH001)** nhé, mail a@kh001.vn")
    expect(linkifyMentions("không có thẻ")).toBe("không có thẻ")
  })
})
