import { splitMentions, type RefView } from "./mentions"

/**
 * DOM của ô soạn thảo có thẻ @ (contenteditable): chữ = text node, thẻ = `<span contenteditable=false data-code>`.
 * Giá trị lưu là CHỮ (`@SP001`) — dựng DOM từ chữ và ngược lại ở đây (thuần DOM, test được bằng jsdom). Mọi nhãn
 * đi qua `textContent` (không innerHTML) — tên bản ghi do người dùng nhập không thể chèn mã HTML.
 */
export const CHIP_CLASSES = "mx-0.5 inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 align-baseline text-sm text-primary cursor-pointer select-none"

export function setChipLabel(chip: HTMLElement, view: RefView | null | undefined): void {
  const code = chip.dataset.code ?? ""
  chip.textContent = ""
  const c = document.createElement("span")
  c.className = "font-mono text-xs font-semibold"
  c.textContent = code
  chip.appendChild(c)
  if (view) {
    const t = document.createElement("span")
    t.textContent = view.title
    chip.appendChild(t)
    chip.dataset.href = view.href ?? ""
    chip.title = `${view.table}: ${view.title}`
    chip.classList.remove("opacity-60")
  } else if (view === null) {
    chip.title = "Không tìm thấy hoặc bạn không có quyền xem"
    chip.classList.add("opacity-60")
  }
}

export function makeChip(code: string, view?: RefView | null): HTMLSpanElement {
  const chip = document.createElement("span")
  chip.contentEditable = "false"
  chip.dataset.code = code
  chip.dataset.testid = "mention-chip"
  chip.className = CHIP_CLASSES
  setChipLabel(chip, view)
  return chip
}

/** Dựng lại toàn bộ nội dung từ chữ. `labels`: mã → bản ghi (thiếu = chưa biết, null = không tìm thấy). */
export function renderValue(root: HTMLElement, text: string, labels?: Map<string, RefView | null>): void {
  root.textContent = ""
  for (const s of splitMentions(text)) {
    if (s.kind === "text") root.appendChild(document.createTextNode(s.text))
    else root.appendChild(makeChip(s.code, labels?.has(s.code) ? labels.get(s.code) : undefined))
  }
}

export function updateChipLabels(root: HTMLElement, labels: Map<string, RefView | null>): void {
  root.querySelectorAll<HTMLElement>("[data-code]").forEach((chip) => {
    const code = chip.dataset.code ?? ""
    if (labels.has(code)) setChipLabel(chip, labels.get(code))
  })
}

/** DOM → chữ lưu. Chịu được `<div>`/`<br>` trình duyệt tự chèn khi Enter. */
export function serialize(root: Node): string {
  let out = ""
  root.childNodes.forEach((n, i) => {
    if (n.nodeType === Node.TEXT_NODE) out += (n.textContent ?? "").replace(/ /g, " ")
    else if (n instanceof HTMLElement) {
      if (n.dataset.code) out += `@${n.dataset.code}`
      else if (n.tagName === "BR") out += "\n"
      else if (n.tagName === "DIV" || n.tagName === "P") out += `${i > 0 ? "\n" : ""}${serialize(n)}`
      else out += serialize(n)
    }
  })
  return out
}

/** Con trỏ đang nằm trong một text node của `root` ⇒ node + vị trí + chữ trước con trỏ (trong node đó). */
export function caretText(root: HTMLElement): { node: Text; offset: number; before: string } | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null
  const node = sel.anchorNode
  if (!node || node.nodeType !== Node.TEXT_NODE || !root.contains(node)) return null
  return { node: node as Text, offset: sel.anchorOffset, before: (node.textContent ?? "").slice(0, sel.anchorOffset) }
}

export function placeCaret(node: Node, offset: number): void {
  const sel = window.getSelection()
  if (!sel) return
  const r = document.createRange()
  r.setStart(node, offset)
  r.collapse(true)
  sel.removeAllRanges()
  sel.addRange(r)
}

export function placeCaretAtEnd(root: HTMLElement): void {
  const r = document.createRange()
  r.selectNodeContents(root)
  r.collapse(false)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(r)
}

/** Thay chữ `[start, end)` trong `node` (vd "@Nguy") bằng thẻ + một khoảng trắng; con trỏ đứng sau khoảng trắng. */
export function replaceWithChip(node: Text, start: number, end: number, chip: HTMLElement): void {
  const after = node.splitText(end)
  node.textContent = (node.textContent ?? "").slice(0, start)
  const space = document.createTextNode(" ")
  after.parentNode?.insertBefore(chip, after)
  after.parentNode?.insertBefore(space, after)
  if (after.textContent === "") after.remove()
  if (node.textContent === "") node.remove()
  placeCaret(space, 1)
}

/** Thẻ đứng NGAY trước con trỏ (để Backspace xoá cả thẻ). */
export function chipBeforeCaret(root: HTMLElement): HTMLElement | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null
  const { anchorNode: n, anchorOffset: o } = sel
  if (!n || !root.contains(n)) return null
  let prev: Node | null = null
  if (n.nodeType === Node.TEXT_NODE) prev = o === 0 ? n.previousSibling : null
  else prev = n.childNodes[o - 1] ?? null
  return prev instanceof HTMLElement && prev.dataset.code ? prev : null
}
