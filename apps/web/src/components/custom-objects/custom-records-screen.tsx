"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Download, Loader2, Plus, Search, Settings2 } from "lucide-react"
import { toast } from "sonner"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ShellPageHeader } from "@/components/app-shell/page-header"
import { ShellResponsiveList } from "@/components/app-shell/responsive-list"
import { ShellListCard, ShellListCardRow } from "@/components/app-shell/list-card"
import { ShellEmptyState } from "@/components/app-shell/empty-state"
import { ShellTableEmptyRow } from "@/components/app-shell/table-empty-row"
import { MobileFilterSheet } from "@/components/app-shell/mobile-filter-sheet"
import { MOBILE_FAB_CLASS } from "@/components/app-shell/mobile-primary"
import { DEFAULT_PAGE_SIZE, downloadCustomRecordsCsv, useCustomRecords } from "@/hooks/custom-objects/use-custom-objects"
import { SORTABLE_TYPES } from "@/lib/custom-objects/field-meta"
import { customIcon } from "@/lib/custom-objects/icons"
import { getApiErrorMessage } from "@/lib/api-client"
import { formatDateTimeVn } from "@/lib/format"
import { formatNumberVn } from "@/lib/custom-objects/format-value"
import { usePermissions } from "@/lib/rbac"
import { cn } from "@/lib/utils"
import type { CustomFieldDef, CustomObjectDef, CustomViewDef } from "@/types/custom-objects"
import { ViewTabs } from "./view-tabs"
import { CustomFieldValue } from "./custom-field-value"
import { RecordCode } from "./record-code"
import { RecordsPager } from "./records-pager"
import { ActiveFilterChips, buildFilterParam, CustomRecordsFilters, filterChips, type FilterState } from "./custom-records-filters"
import { SortHeader } from "@/components/ui/sort-header"
import { LoadingBlock } from "@/components/ui/loading-block"

const MAX_COLS = 6

/** Gộp bộ lọc cố định của màn xem với bộ lọc người dùng chọn; người dùng chọn cùng trường thì thắng. */
function mergeFilter(fixed: Record<string, unknown> | undefined, user: string | undefined): string | undefined {
  if (!fixed || Object.keys(fixed).length === 0) return user
  return JSON.stringify({ ...fixed, ...(user ? (JSON.parse(user) as Record<string, unknown>) : {}) })
}

/**
 * Danh sách bản ghi của 1 tính năng tuỳ biến: tìm theo tiêu đề, lọc theo trường, sắp xếp theo cột, cursor
 * (nút "Tải thêm"), xuất CSV. Bảng ≥640px, thẻ <640px. BE lọc phạm vi/che SĐT — FE chỉ hiển thị.
 */
export function CustomRecordsScreen({ def, view }: { def: CustomObjectDef; view?: CustomViewDef }) {
  const router = useRouter()
  const { can } = usePermissions()
  const canCreate = can("custom_records.manage")
  const [searchInput, setSearchInput] = useState("")
  const [q, setQ] = useState("")
  // màn danh sách đã dựng mang sẵn cột, sắp xếp, bộ lọc cố định.
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(view?.config.sort ? { key: view.config.sort.field, dir: view.config.sort.dir } : null)
  const [filters, setFilters] = useState<FilterState>({})
  const [activeFilters, setActiveFilters] = useState<string[]>([])
  const [exporting, setExporting] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)
  const searchTimer = useRef<number | null>(null)
  useEffect(() => () => { if (searchTimer.current !== null) window.clearTimeout(searchTimer.current) }, [])

  const params = useMemo(() => ({
    q: q || undefined,
    sort: sort ? (sort.key === "__updated" ? "updated_at" : `field:${sort.key}`) : undefined,
    dir: sort?.dir,
    filter: mergeFilter(view?.config.filter, buildFilterParam(def, filters)),
  }), [q, sort, filters, def, view])
  // Đổi tìm kiếm / bộ lọc / sắp xếp → về trang 1 (điều chỉnh state ngay lúc render, không useEffect).
  const paramsKey = JSON.stringify(params)
  const [seenKey, setSeenKey] = useState(paramsKey)
  if (seenKey !== paramsKey) { setSeenKey(paramsKey); setPage(1) }
  const query = useCustomRecords(def.key, params, page, pageSize)
  const rows = useMemo(() => query.data?.items ?? [], [query.data])
  const total = query.data?.total ?? null
  const pageCount = total === null ? 1 : Math.max(1, Math.ceil(total / pageSize))
  // Xoá bản ghi cuối của trang cuối → lùi về trang còn dữ liệu.
  if (total !== null && page > pageCount) setPage(pageCount)
  const listFields = useMemo(() => {
    const cols = view?.config.columns
    if (cols?.length) return cols.map((k) => def.fields.find((f) => f.key === k)).filter((f): f is CustomFieldDef => !!f).slice(0, MAX_COLS)
    return def.fields.filter((f) => f.show_in_list).slice(0, MAX_COLS)
  }, [def.fields, view])
  const Icon = customIcon(def.icon)
  // Chỉ đếm bộ lọc NGƯỜI DÙNG chọn — bộ lọc cố định của màn dựng sẵn không tính (nút Đặt lại không xoá được nó).
  const userFilter = buildFilterParam(def, filters)
  const filterCount = Object.keys(userFilter ? JSON.parse(userFilter) : {}).length

  function toggleSort(f: CustomFieldDef) {
    if (!SORTABLE_TYPES.includes(f.type)) return
    setSort((s) => (!s || s.key !== f.key ? { key: f.key, dir: "asc" } : s.dir === "asc" ? { key: f.key, dir: "desc" } : null))
  }

  async function onExport() {
    setExporting(true)
    try {
      const r = await downloadCustomRecordsCsv(def.key, params)
      if (r.truncated) toast.warning(`Đã xuất ${formatNumberVn(r.exported)} bản ghi MỚI NHẤT trong tổng ${formatNumberVn(r.total)}. Hãy lọc thu hẹp để xuất phần còn lại.`)
      else toast.success(`Đã xuất ${formatNumberVn(r.exported)} bản ghi`)
    } catch (e) {
      toast.error(getApiErrorMessage(e, "Không xuất được file"))
    } finally {
      setExporting(false)
    }
  }

  const addBtn = canCreate && (
    <Link href={`/x/${def.key}/new`} className={cn(buttonVariants(), MOBILE_FAB_CLASS)}>
      <Plus className="mr-1.5 size-4" /> Thêm {def.label.toLowerCase()}
    </Link>
  )

  return (
    <div className="space-y-4">
      <ShellPageHeader
        icon={Icon}
        title={view?.label ?? def.label_plural}
        description={def.description ?? undefined}
        badge={total !== null ? <span className="rounded-full bg-muted px-2 py-0.5 text-sm font-medium text-muted-foreground">{formatNumberVn(total)}</span> : undefined}
        actions={
          <>
            {can("custom_objects.manage") && can("settings.features") && (
              <Link href="/settings?tab=features" className={cn(buttonVariants({ variant: "outline" }), "max-sm:min-h-11")}>
                <Settings2 className="mr-1.5 size-4" /> Cấu hình
              </Link>
            )}
            {can("custom_records.export") && (
              <Button variant="outline" onClick={onExport} disabled={exporting}>
                {exporting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Download className="mr-1.5 size-4" />} Xuất CSV
              </Button>
            )}
            {addBtn}
          </>
        }
      />

      <ViewTabs objectKey={def.key} active={view?.key ?? null} />

      {/* Giao diện mới: ô tìm + bộ lọc chung một hàng trên màn rộng, thay vì xếp chồng trong khung cao. */}
      <Card className="gap-3 p-3 sm:flex-row sm:flex-wrap sm:items-start">
        <div className="relative sm:w-80 sm:flex-none">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => {
              const next = e.target.value
              setSearchInput(next)
              if (searchTimer.current !== null) window.clearTimeout(searchTimer.current)
              searchTimer.current = window.setTimeout(() => setQ(next.trim()), 300)
            }}
            placeholder="Tìm tên, mã, nội dung…"
            aria-label="Tìm kiếm"
            className="pl-9"
          />
        </div>
        <MobileFilterSheet activeCount={filterCount} onReset={() => { setFilters({}); setActiveFilters([]) }} title="Bộ lọc">
          <CustomRecordsFilters def={def} state={filters} active={activeFilters} onActiveChange={setActiveFilters} onChange={setFilters} />
        </MobileFilterSheet>
        {/* Điện thoại: bộ lọc nằm trong bảng trượt → chip cho thấy đang lọc gì, bỏ nhanh không cần mở bảng. */}
        <ActiveFilterChips
          className="basis-full sm:hidden"
          chips={filterChips(def, filters)}
          onRemove={(key) => {
            setActiveFilters((a) => a.filter((k) => k !== key))
            setFilters((s) => { const next = { ...s }; delete next[key]; return next })
          }}
          onClear={() => { setFilters({}); setActiveFilters([]) }}
        />
      </Card>

      {query.isError ? (
        <Card><ShellEmptyState icon={Icon} title="Không tải được dữ liệu" description={getApiErrorMessage(query.error, "Vui lòng thử lại sau")} /></Card>
      ) : (
        <ShellResponsiveList
          table={
            <Card className="gap-0 overflow-hidden p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-20">Mã</TableHead>
                      {listFields.map((f) => (
                        <TableHead key={f.key} aria-sort={sort?.key === f.key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
                          {SORTABLE_TYPES.includes(f.type) ? (
                            <SortHeader label={f.label} dir={sort?.key === f.key ? sort.dir : null} onToggle={() => toggleSort(f)} />
                          ) : f.label}
                        </TableHead>
                      ))}
                      <TableHead>Phụ trách</TableHead>
                      <TableHead>
                        <SortHeader
                          label="Cập nhật"
                          dir={sort?.key === "__updated" ? sort.dir : null}
                          onToggle={() => setSort((s) => (s?.key === "__updated" ? (s.dir === "desc" ? null : { key: "__updated", dir: "desc" }) : { key: "__updated", dir: "desc" }))}
                        />
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {query.isLoading && <ShellTableEmptyRow colSpan={listFields.length + 3}><LoadingBlock count={3} /></ShellTableEmptyRow>}
                    {!query.isLoading && rows.length === 0 && (
                      <ShellTableEmptyRow colSpan={listFields.length + 3}>
                        {q || filterCount ? "Không có kết quả phù hợp bộ lọc" : `Chưa có ${def.label.toLowerCase()} nào`}
                      </ShellTableEmptyRow>
                    )}
                    {rows.map((r) => (
                      <TableRow key={r.id} className="cursor-pointer" onClick={() => router.push(`/x/${def.key}/${r.id}`)}>
                        <TableCell className="align-top"><RecordCode code={r.code} /></TableCell>
                        {listFields.map((f) => (
                          <TableCell key={f.key} className="max-w-64 align-top">
                            {f.is_title ? <Link href={`/x/${def.key}/${r.id}`} className="font-semibold text-primary underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>{r.title}</Link> : <CustomFieldValue field={f} record={r} />}
                          </TableCell>
                        ))}
                        <TableCell className="align-top">{r.owner_name ?? "—"}</TableCell>
                        <TableCell className="align-top whitespace-nowrap">{formatDateTimeVn(r.updated_at)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Card>
          }
          cards={
            <div className="space-y-3">
              {query.isLoading && <LoadingBlock variant="cards" count={3} className="p-3" />}
              {!query.isLoading && rows.length === 0 && (
                <Card><ShellEmptyState icon={Icon} title={q || filterCount ? "Không có kết quả" : `Chưa có ${def.label.toLowerCase()} nào`} /></Card>
              )}
              {rows.map((r) => (
                <ShellListCard key={r.id} onClick={() => router.push(`/x/${def.key}/${r.id}`)}>
                  <p className="flex items-center gap-2 text-base font-semibold"><RecordCode code={r.code} />{r.title}</p>
                  {listFields.filter((f) => !f.is_title).slice(0, 4).map((f) => (
                    <ShellListCardRow key={f.key} label={f.label} value={<CustomFieldValue field={f} record={r} />} />
                  ))}
                  <ShellListCardRow label="Phụ trách" value={r.owner_name ?? "—"} />
                </ShellListCard>
              ))}
            </div>
          }
        />
      )}

      {(rows.length > 0 || page > 1) && (
        <RecordsPager page={page} pageSize={pageSize} total={total} shown={rows.length} loading={query.isFetching}
          onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1) }} />
      )}
    </div>
  )
}
