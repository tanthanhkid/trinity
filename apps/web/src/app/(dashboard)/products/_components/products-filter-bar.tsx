"use client"

/**
 * Thanh lọc màn "Sản phẩm": Search/Select cùng cao `h-10`, bật/tắt
 * "Hiện cả sản phẩm đã tắt" bằng Switch dùng chung, hiện tổng số sau lọc.
 * Mobile: ô lọc giãn full-width.
 */
import { Search } from "lucide-react"
import { Input } from "@/components/ui/input"
import { MobileFilterSheet } from "@/components/app-shell/mobile-filter-sheet"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export const ALL_SENTINEL = "ALL"

interface Option {
  id: number
  name: string
}

function FilterSelect({
  value,
  onChange,
  options,
  allLabel,
}: {
  value: string
  onChange: (v: string) => void
  options: Option[]
  allLabel: string
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange(v ?? ALL_SENTINEL)}
      items={[
        { value: ALL_SENTINEL, label: allLabel },
        ...options.map((o) => ({ value: String(o.id), label: o.name })),
      ]}
    >
      <SelectTrigger className="h-10 w-full max-sm:h-11 sm:w-56">
        <SelectValue placeholder={allLabel}>
          {(v) => {
            if (v === ALL_SENTINEL || !v) return allLabel
            return options.find((o) => String(o.id) === v)?.name ?? allLabel
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_SENTINEL}>{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.id} value={String(o.id)}>
            {o.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export interface ProductsFilterBarProps {
  search: string
  onSearchChange: (v: string) => void
  categoryFilter: string
  onCategoryChange: (v: string) => void
  projectFilter: string
  onProjectChange: (v: string) => void
  showInactive: boolean
  onShowInactiveChange: (v: boolean) => void
  categories: Option[]
  projects: Option[]
  total: number
}

export function ProductsFilterBar(p: ProductsFilterBarProps) {
  const activeCount =
    (p.categoryFilter !== ALL_SENTINEL ? 1 : 0) +
    (p.projectFilter !== ALL_SENTINEL ? 1 : 0) +
    (p.showInactive ? 1 : 0)
  function resetFilters() {
    p.onCategoryChange(ALL_SENTINEL)
    p.onProjectChange(ALL_SENTINEL)
    p.onShowInactiveChange(false)
  }
  return (
    <div className="flex flex-col gap-3 max-sm:flex-row max-sm:flex-wrap max-sm:items-center sm:flex-row sm:flex-wrap sm:items-center">
      <div className="relative w-full max-sm:basis-full sm:max-w-xs">
        <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={p.search}
          onChange={(e) => p.onSearchChange(e.target.value)}
          placeholder="Tìm mã, tên, thương hiệu…"
          className="h-10 pl-9 max-sm:h-11"
        />
      </div>
      <MobileFilterSheet activeCount={activeCount} onReset={resetFilters}>
      <FilterSelect
        value={p.categoryFilter}
        onChange={p.onCategoryChange}
        options={p.categories}
        allLabel="Tất cả danh mục"
      />
      <FilterSelect
        value={p.projectFilter}
        onChange={p.onProjectChange}
        options={p.projects}
        allLabel="Tất cả dự án"
      />
      <div className="flex h-10 items-center gap-2 text-sm text-foreground max-sm:min-h-11">
        <Switch
          id="products-show-inactive"
          checked={p.showInactive}
          onCheckedChange={p.onShowInactiveChange}
        />
        <label htmlFor="products-show-inactive" className="cursor-pointer max-sm:flex max-sm:min-h-11 max-sm:flex-1 max-sm:items-center">
          Hiện cả sản phẩm đã tắt
        </label>
      </div>
      </MobileFilterSheet>
      <span className="ml-auto text-sm font-medium text-muted-foreground" aria-live="polite">
        Tổng <strong className="text-foreground">{p.total}</strong> sản phẩm
      </span>
    </div>
  )
}
