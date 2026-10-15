"use client"

import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react"
import type { ContactFilters } from "@/hooks/use-contacts"
import type { SortField } from "./contacts-constants"
import { ShellCheckbox as Checkbox } from "@/components/app-shell/checkbox"
import { cn } from "@/lib/utils"

function SortIcon({ field, filters }: { field: SortField; filters: ContactFilters }) {
  if (filters.sortBy !== field) return <ArrowUpDown className="ml-1 h-3.5 w-3.5 opacity-40" />
  return filters.sortOrder === "asc"
    ? <ArrowUp className="ml-1 h-3.5 w-3.5" />
    : <ArrowDown className="ml-1 h-3.5 w-3.5" />
}

function SortButton({ field, filters, onToggleSort, children }: {
  field: SortField
  filters: ContactFilters
  onToggleSort: (field: SortField) => void
  children: string
}) {
  const active = filters.sortBy === field
  return (
    <button
      type="button"
      onClick={() => onToggleSort(field)}
      className="inline-flex items-center rounded font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      aria-label={`Sắp xếp theo ${children.toLowerCase()}`}
      aria-pressed={active}
    >
      {children}
      <SortIcon field={field} filters={filters} />
    </button>
  )
}

interface ContactsTableHeaderProps {
  filters: ContactFilters
  onToggleSort: (field: SortField) => void
  showSelection: boolean
  allSelected: boolean
  onToggleSelectAll: (checked: boolean) => void
  /** Cột "Mức quan tâm" (tính năng `lead_scoring` của tổ chức). */
  showScore?: boolean
}

/** `<thead>` bảng Khách hàng — cột ẩn/hiện theo bề ngang khớp `ContactRow`. */
export function ContactsTableHeader({
  filters,
  onToggleSort,
  showSelection,
  allSelected,
  onToggleSelectAll,
  showScore = true,
}: ContactsTableHeaderProps) {
  const th = "px-3 py-2.5 text-left text-sm font-medium text-muted-foreground whitespace-nowrap"
  return (
    <thead className="border-b border-[var(--border)]">
      <tr>
        {showSelection ? (
          <th scope="col" className="w-11 py-2.5 pl-4 pr-1 text-left">
            <Checkbox
              checked={allSelected}
              onCheckedChange={(v) => onToggleSelectAll(v === true)}
              aria-label="Chọn tất cả khách hàng"
            />
          </th>
        ) : null}
        <th scope="col" className={cn(th, showSelection ? "pl-2" : "pl-4")}>
          <SortButton field="full_name" filters={filters} onToggleSort={onToggleSort}>Khách hàng</SortButton>
        </th>
        {showScore && (
          <th scope="col" className={cn(th, "hidden md:table-cell")}>
            <SortButton field="lead_score" filters={filters} onToggleSort={onToggleSort}>Mức quan tâm</SortButton>
          </th>
        )}
        <th scope="col" className={cn(th, "hidden lg:table-cell")}>Phụ trách</th>
        <th scope="col" className={th}>Điện thoại</th>
        <th scope="col" className={th}>Giai đoạn</th>
        <th scope="col" className={cn(th, "hidden pr-4 xl:table-cell")}>Tín hiệu</th>
      </tr>
    </thead>
  )
}
