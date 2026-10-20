/**
 * Tính "thả vào cột nào, vị trí thứ mấy" cho bảng kanban — dùng chung cho
 * board Kanban và view kanban của bảng tuỳ biến.
 *
 * Vì sao không dựa vào droppable của từng thẻ: khi ô giữ chỗ chen vào, các thẻ
 * dưới bị đẩy xuống → thẻ nằm dưới con trỏ đổi → ô giữ chỗ nhảy qua lại.
 * Ở đây chụp vị trí các thẻ MỘT LẦN lúc bắt đầu kéo (toạ độ trong vùng cuộn
 * của cột) rồi so con trỏ với bản chụp đó, nên vị trí đích ổn định.
 *
 * Quy ước DOM:
 * - `[data-board-column="<khoá cột>"]` — cả cột (xác định cột theo trục X).
 * - `[data-board-list]` bên trong cột — vùng cuộn chứa thẻ.
 * - `[data-board-item="<id thẻ>"]` — từng thẻ, theo thứ tự hiển thị.
 */

export interface ColumnSnapshot {
  /** Id thẻ theo thứ tự, ĐÃ bỏ thẻ đang kéo. */
  ids: string[]
  /** Tâm dọc của từng thẻ (cùng thứ tự `ids`), tính trong vùng cuộn của cột. */
  mids: number[]
}

export interface BoardDropTarget {
  column: string
  /** Vị trí chèn trong `ids` của cột đích (đã bỏ thẻ đang kéo). */
  index: number
}

/** Số thẻ có tâm nằm trên con trỏ = vị trí chèn. */
export function indexFromMidpoints(mids: number[], y: number): number {
  let i = 0
  while (i < mids.length && mids[i] < y) i++
  return i
}

/** Cột gần con trỏ nhất theo trục X (con trỏ nằm trong cột thì khoảng cách 0). */
export function nearestColumn(
  columns: { key: string; left: number; right: number }[],
  x: number,
): string | null {
  let best: string | null = null
  let bestDist = Infinity
  for (const c of columns) {
    const d = x < c.left ? c.left - x : x > c.right ? x - c.right : 0
    if (d < bestDist) {
      bestDist = d
      best = c.key
    }
  }
  return best
}

export function snapshotBoard(root: HTMLElement, activeItemId: string): Map<string, ColumnSnapshot> {
  const out = new Map<string, ColumnSnapshot>()
  root.querySelectorAll<HTMLElement>("[data-board-column]").forEach((col) => {
    const key = col.dataset.boardColumn!
    const list = col.querySelector<HTMLElement>("[data-board-list]")
    const ids: string[] = []
    const mids: number[] = []
    if (list) {
      const listTop = list.getBoundingClientRect().top - list.scrollTop
      list.querySelectorAll<HTMLElement>("[data-board-item]").forEach((el) => {
        const id = el.dataset.boardItem!
        if (id === activeItemId) return
        const r = el.getBoundingClientRect()
        ids.push(id)
        mids.push(r.top - listTop + r.height / 2)
      })
    }
    out.set(key, { ids, mids })
  })
  return out
}

export function resolveDropTarget(
  root: HTMLElement,
  snapshot: Map<string, ColumnSnapshot>,
  pointer: { x: number; y: number },
): BoardDropTarget | null {
  const cols = Array.from(root.querySelectorAll<HTMLElement>("[data-board-column]")).map((el) => {
    const r = el.getBoundingClientRect()
    return { key: el.dataset.boardColumn!, left: r.left, right: r.right, el }
  })
  const key = nearestColumn(cols, pointer.x)
  if (key == null) return null
  const snap = snapshot.get(key)
  if (!snap) return null
  const list = cols.find((c) => c.key === key)!.el.querySelector<HTMLElement>("[data-board-list]")
  if (!list) return { column: key, index: snap.ids.length }
  const y = pointer.y - list.getBoundingClientRect().top + list.scrollTop
  return { column: key, index: indexFromMidpoints(snap.mids, y) }
}

/** Thẻ đứng trước/sau vị trí chèn — dùng làm `before`/`after` khi gửi lệnh chuyển. */
export function neighboursAt(snap: ColumnSnapshot, index: number): { prev?: string; next?: string } {
  return { prev: snap.ids[index - 1], next: snap.ids[index] }
}
