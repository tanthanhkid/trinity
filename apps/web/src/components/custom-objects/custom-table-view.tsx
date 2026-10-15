"use client"

import { useState } from "react"
import Link from "next/link"
import { Loader2, Search, Table2 } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ShellPageHeader } from "@/components/app-shell/page-header"
import { ShellTableEmptyRow } from "@/components/app-shell/table-empty-row"
import { DEFAULT_PAGE_SIZE, useCustomRecordMutations, useCustomRecords } from "@/hooks/custom-objects/use-custom-objects"
import { getApiErrorMessage } from "@/lib/api-client"
import { usePermissions } from "@/lib/rbac"
import type { CustomFieldDef, CustomObjectDef, CustomViewDef } from "@/types/custom-objects"
import { RecordCode } from "./record-code"
import { RecordsPager } from "./records-pager"
import { TableCellEditor } from "./table-cell-editor"
import { ViewTabs } from "./view-tabs"

/**
 * Kiểu xem Bảng: bảng tính sửa nhanh TẠI Ô — bấm ô để sửa (BE kiểm như form; ngoài phạm vi sửa thì chỉ xem). Cột theo
 * `config.columns` (không đặt = trường hiện ở danh sách). Bấm mã/tiêu đề mở chi tiết.
 */
export function CustomTableView({ def, view }: { def: CustomObjectDef; view: CustomViewDef }) {
  const { can } = usePermissions()
  const canEdit = can("custom_records.manage")
  const { update } = useCustomRecordMutations(def.key)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [q, setQ] = useState("")
  const cols = (view.config.columns?.length ? view.config.columns.map((k) => def.fields.find((f) => f.key === k)) : def.fields.filter((f) => f.show_in_list))
    .filter((f): f is CustomFieldDef => !!f)
  const sort = view.config.sort ? `field:${view.config.sort.field}` : undefined
  const filter = view.config.filter ? JSON.stringify(view.config.filter) : undefined
  const query = useCustomRecords(def.key, { q: q.trim() || undefined, sort, dir: view.config.sort?.dir, filter }, page, pageSize)
  const rows = query.data?.items ?? []
  const save = (id: number, key: string, value: unknown) => update.mutateAsync({ id, input: { data: { [key]: value } } })

  return (
    <div className="space-y-4">
      <ShellPageHeader icon={Table2} title={view.label} description={`${def.label_plural} · bấm vào ô để sửa nhanh${canEdit ? "" : " (bạn chỉ có quyền xem)"}`} />
      <ViewTabs objectKey={def.key} active={view.key} />
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1) }} placeholder="Tìm theo tên hoặc mã…" className="pl-9" aria-label="Tìm" />
      </div>
      {query.isError && <p className="text-sm text-red-700">{getApiErrorMessage(query.error, "Không tải được dữ liệu")}</p>}
      <Card className="gap-0 overflow-hidden rounded-2xl p-0">
        <div className="overflow-x-auto">
          <Table data-testid="custom-table-view">
            <TableHeader>
              <TableRow>
                <TableHead className="w-20">Mã</TableHead>
                {cols.map((f) => <TableHead key={f.key} className="min-w-40">{f.label}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.isLoading && <ShellTableEmptyRow colSpan={cols.length + 1}><Loader2 className="mx-auto size-4 animate-spin" /></ShellTableEmptyRow>}
              {!query.isLoading && rows.length === 0 && <ShellTableEmptyRow colSpan={cols.length + 1}>{q ? "Không có kết quả" : `Chưa có ${def.label.toLowerCase()} nào`}</ShellTableEmptyRow>}
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="align-top"><Link href={`/x/${def.key}/${r.id}`} aria-label={`Mở ${r.title}`}><RecordCode code={r.code ?? `#${r.id}`} /></Link></TableCell>
                  {cols.map((f) => (
                    <TableCell key={f.key} className="max-w-72 align-top">
                      <TableCellEditor field={f} record={r} canEdit={canEdit} onSave={save} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>
      {(rows.length > 0 || page > 1) && (
        <RecordsPager page={page} pageSize={pageSize} total={query.data?.total ?? null} shown={rows.length} loading={query.isFetching}
          onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1) }} />
      )}
    </div>
  )
}
