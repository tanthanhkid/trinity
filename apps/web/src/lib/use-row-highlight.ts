"use client"

import { useState } from "react"

/**
 * Tô xám nhẹ dòng đang được người dùng click trong bảng dữ liệu.
 * Dùng chung cho Quản lý nhân viên / Hợp đồng / Lương (tab Nhân viên + Phiếu lương).
 *
 * Cách dùng:
 *   const { isSelected, selectRow, rowHighlightClass } = useRowHighlight<number>()
 *   <TableRow
 *     onClick={() => selectRow(e.id)}
 *     className={cn("cursor-pointer", rowHighlightClass(e.id))}
 *   >
 */
export function useRowHighlight<T extends string | number>() {
  const [selectedId, setSelectedId] = useState<T | null>(null)

  const isSelected = (id: T) => selectedId === id
  const selectRow = (id: T) => setSelectedId(id)
  // Class tô xám nhẹ — giữ hover bình thường cho các dòng khác.
  const rowHighlightClass = (id: T) => (selectedId === id ? "bg-muted/60" : "")

  return { selectedId, isSelected, selectRow, rowHighlightClass }
}
