"use client"

/**
 * Theo con trỏ trong lúc kéo thẻ trên bảng kanban và trả về vị trí thả
 * (cột + thứ tự) — xem `lib/board-drag-target.ts` cho quy ước DOM.
 * Kéo-nhấc vẫn do `@dnd-kit/core` lo; hook này chỉ lo "ô giữ chỗ ở đâu".
 */
import { useCallback, useEffect, useRef, useState } from "react"
import {
  resolveDropTarget,
  snapshotBoard,
  type BoardDropTarget,
  type ColumnSnapshot,
} from "@/lib/board-drag-target"

export interface BoardDropResult {
  target: BoardDropTarget
  /** Bản chụp cột đích (thứ tự thẻ đã bỏ thẻ đang kéo). */
  snapshot: ColumnSnapshot
  /** Thả lại đúng chỗ cũ — không cần gọi máy chủ. */
  unchanged: boolean
}

export function useBoardDrag<T extends HTMLElement = HTMLDivElement>() {
  const rootRef = useRef<T>(null)
  const [target, setTarget] = useState<BoardDropTarget | null>(null)
  const targetRef = useRef<BoardDropTarget | null>(null)
  const originRef = useRef<BoardDropTarget | null>(null)
  const snapRef = useRef<Map<string, ColumnSnapshot> | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)

  const update = useCallback((t: BoardDropTarget) => {
    const cur = targetRef.current
    if (cur && cur.column === t.column && cur.index === t.index) return
    targetRef.current = t
    setTarget(t)
  }, [])

  const detach = useCallback(() => {
    cleanupRef.current?.()
    cleanupRef.current = null
  }, [])

  /** Bắt đầu theo dõi; trả về kích thước thẻ đang kéo (cho ô giữ chỗ + bản nhấc lên). */
  const start = useCallback(
    (itemId: string, column: string): { width: number; height: number } | null => {
      const root = rootRef.current
      if (!root) return null
      detach()
      const snap = snapshotBoard(root, itemId)
      snapRef.current = snap
      const items = Array.from(
        root.querySelectorAll<HTMLElement>(`[data-board-column="${CSS.escape(column)}"] [data-board-item]`),
      )
      const itemIdx = items.findIndex((el) => el.dataset.boardItem === itemId)
      const itemRect = itemIdx >= 0 ? items[itemIdx].getBoundingClientRect() : null
      const origin = { column, index: Math.max(0, itemIdx) }
      originRef.current = origin
      update(origin)

      let frame = 0
      let pointer: { x: number; y: number } | null = null
      const recompute = () => {
        frame = 0
        if (!pointer) return
        const t = resolveDropTarget(root, snap, pointer)
        if (t) update(t)
      }
      const schedule = () => {
        if (!frame) frame = requestAnimationFrame(recompute)
      }
      const onMove = (e: PointerEvent) => {
        pointer = { x: e.clientX, y: e.clientY }
        schedule()
      }
      // Cột/board tự cuộn khi kéo sát mép → con trỏ đứng yên nhưng đích vẫn đổi.
      window.addEventListener("pointermove", onMove)
      window.addEventListener("scroll", schedule, true)
      cleanupRef.current = () => {
        if (frame) cancelAnimationFrame(frame)
        window.removeEventListener("pointermove", onMove)
        window.removeEventListener("scroll", schedule, true)
      }
      return itemRect && itemRect.height > 0 ? { width: itemRect.width, height: itemRect.height } : null
    },
    [detach, update],
  )

  const stop = useCallback((): BoardDropResult | null => {
    detach()
    const t = targetRef.current
    const origin = originRef.current
    const snap = t ? snapRef.current?.get(t.column) : undefined
    targetRef.current = null
    originRef.current = null
    snapRef.current = null
    setTarget(null)
    if (!t || !snap) return null
    const unchanged = origin != null && origin.column === t.column && origin.index === t.index
    return { target: t, snapshot: snap, unchanged }
  }, [detach])

  useEffect(() => detach, [detach])

  return { rootRef, target, start, stop }
}
