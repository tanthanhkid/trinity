"use client"

import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Loader2, Trash2 } from "lucide-react"
import { toast } from "sonner"
import apiClient, { getApiErrorMessage } from "@/lib/api-client"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { reportIdFromName, type CustomReportDef, type CustomReportSource } from "./custom-report-types"

const NONE = "__none__"
const MAX_SUMS = 4

/**
 * Thêm / sửa / xoá một báo cáo (chỉ quản trị viên). Sửa trên TOÀN BỘ danh sách đã lưu (`/definitions`) rồi
 * `PUT` lại cả danh sách — báo cáo của bảng người cấu hình không xem được vẫn được giữ nguyên.
 */
export function ReportEditorDialog({ open, onOpenChange, editId, onSaved }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  editId?: string
  onSaved: (id: string | null) => void
}) {
  const qc = useQueryClient()
  const defs = useQuery<{ reports: CustomReportDef[] }>({
    queryKey: ["custom-report-defs"],
    queryFn: () => apiClient.get("/reports/custom/definitions").then((r) => r.data),
    enabled: open,
  })
  const sources = useQuery<CustomReportSource[]>({
    queryKey: ["custom-report-sources"],
    queryFn: () => apiClient.get("/reports/custom/sources").then((r) => r.data),
    enabled: open,
    staleTime: 60_000,
  })
  const editing = defs.data?.reports.find((r) => r.id === editId)

  const [confirmDelete, setConfirmDelete] = useState(false)

  const save = useMutation({
    mutationFn: (reports: CustomReportDef[]) => apiClient.put("/reports/custom", { reports }).then((r) => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["custom-reports"] })
      void qc.invalidateQueries({ queryKey: ["custom-report-defs"] })
      void qc.invalidateQueries({ queryKey: ["custom-report"] })
    },
  })

  function submit(def: Omit<CustomReportDef, "id">) {
    const all = defs.data?.reports ?? []
    const id = editing?.id ?? reportIdFromName(def.name, new Set(all.map((r) => r.id)))
    const full: CustomReportDef = { ...(editing ?? {}), ...def, id }
    const next = editing ? all.map((r) => (r.id === id ? full : r)) : [...all, full]
    save.mutate(next, {
      onSuccess: () => { toast.success(editing ? "Đã lưu báo cáo" : "Đã thêm báo cáo"); onSaved(id); onOpenChange(false) },
      onError: (err) => toast.error(getApiErrorMessage(err, "Không lưu được, vui lòng thử lại")),
    })
  }

  function remove() {
    const next = (defs.data?.reports ?? []).filter((r) => r.id !== editId)
    save.mutate(next, {
      onSuccess: () => { toast.success("Đã xoá báo cáo"); setConfirmDelete(false); onSaved(null); onOpenChange(false) },
      onError: (err) => toast.error(getApiErrorMessage(err, "Không xoá được, vui lòng thử lại")),
    })
  }

  const loading = defs.isLoading || sources.isLoading

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editId ? "Sửa báo cáo" : "Thêm báo cáo"}</DialogTitle>
            <DialogDescription>Đếm số bản ghi và cộng tổng theo kỳ (tháng/năm), nhóm theo một trường. Người xem chỉ thấy số liệu trong phạm vi quyền của họ.</DialogDescription>
          </DialogHeader>
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
          ) : (
            // `key`: mỗi lần mở / đổi báo cáo là form mới, nạp đúng giá trị cũ (không đồng bộ state bằng effect).
            <EditorForm key={`${editId ?? "new"}`} initial={editing} sources={sources.data ?? []} onSubmit={submit} />
          )}
          <DialogFooter className="gap-2 sm:justify-between">
            {editId ? (
              <Button type="button" variant="ghost" className="text-[var(--color-app-tag-red-ink)]" onClick={() => setConfirmDelete(true)} disabled={save.isPending}>
                <Trash2 className="size-4" />Xoá báo cáo
              </Button>
            ) : <span />}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Huỷ</Button>
              <Button type="submit" form="report-editor" disabled={save.isPending || loading}>
                {save.isPending && <Loader2 className="size-4 animate-spin" />}Lưu
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Xoá báo cáo này?"
        description={<>Báo cáo <b>{editing?.name}</b> sẽ biến mất với mọi người. Dữ liệu trong bảng không bị ảnh hưởng.</>}
        confirmLabel="Xoá báo cáo"
        pending={save.isPending}
        onConfirm={remove}
      />
    </>
  )
}

function EditorForm({ initial, sources, onSubmit }: {
  initial?: CustomReportDef
  sources: CustomReportSource[]
  onSubmit: (def: Omit<CustomReportDef, "id">) => void
}) {
  const [name, setName] = useState(initial?.name ?? "")
  const [source, setSource] = useState(initial?.source ?? "")
  const [dateField, setDateField] = useState(initial?.date_field ?? "created_at")
  const [sumFields, setSumFields] = useState<string[]>(initial?.sum_fields ?? [])
  const [groupBy, setGroupBy] = useState<string>(initial?.group_by ?? NONE)
  const spec = sources.find((s) => s.source === source)
  const fieldsOf = (role: "date" | "number" | "group") => spec?.fields.filter((f) => f.role === role) ?? []

  function pickSource(v: string) {
    setSource(v)
    // Đổi bảng ⇒ trường cũ không còn nghĩa.
    setDateField("created_at")
    setSumFields([])
    setGroupBy(NONE)
  }
  const toggleSum = (k: string, on: boolean) =>
    setSumFields((cur) => (on ? (cur.length < MAX_SUMS && !cur.includes(k) ? [...cur, k] : cur) : cur.filter((x) => x !== k)))

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) { toast.error("Vui lòng nhập tên báo cáo"); return }
    if (!spec) { toast.error("Chọn bảng cần báo cáo"); return }
    onSubmit({ name: name.trim(), source, date_field: dateField, sum_fields: sumFields, group_by: groupBy === NONE ? null : groupBy })
  }

  return (
    <form id="report-editor" onSubmit={submit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="report-name">Tên báo cáo</Label>
        <Input id="report-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="vd: Thu tiền theo tháng" />
      </div>
      <div className="space-y-1.5">
        <Label>Bảng</Label>
        <Select value={source} onValueChange={(v) => v && pickSource(v)}>
          <SelectTrigger aria-label="Bảng" className="w-full">
            <SelectValue>{(v) => sources.find((s) => s.source === v)?.label ?? <span className="text-muted-foreground">Chọn bảng…</span>}</SelectValue>
          </SelectTrigger>
          <SelectContent>{sources.map((s) => <SelectItem key={s.source} value={s.source}>{s.label}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      {spec && (
        <>
          <div className="space-y-1.5">
            <Label>Lọc kỳ theo</Label>
            <Select value={dateField} onValueChange={(v) => v && setDateField(v)}>
              <SelectTrigger aria-label="Trường ngày" className="w-full">
                <SelectValue>{(v) => fieldsOf("date").find((f) => f.key === v)?.label ?? v}</SelectValue>
              </SelectTrigger>
              <SelectContent>{fieldsOf("date").map((f) => <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <fieldset className="space-y-1.5">
            <legend className="mb-1.5 text-sm font-medium">Cộng tổng các cột <span className="font-normal text-muted-foreground">(tối đa {MAX_SUMS}; số bản ghi luôn có)</span></legend>
            {fieldsOf("number").length ? fieldsOf("number").map((f) => (
              <label key={f.key} className="flex items-center gap-2 text-sm max-sm:min-h-11">
                <Checkbox
                  checked={sumFields.includes(f.key)}
                  disabled={!sumFields.includes(f.key) && sumFields.length >= MAX_SUMS}
                  onCheckedChange={(on) => toggleSum(f.key, on)}
                />
                {f.label}
              </label>
            )) : <p className="text-sm text-muted-foreground">Bảng này chưa có cột số.</p>}
          </fieldset>
          <div className="space-y-1.5">
            <Label>Nhóm theo</Label>
            <Select value={groupBy} onValueChange={(v) => v && setGroupBy(v)}>
              <SelectTrigger aria-label="Nhóm theo" className="w-full">
                <SelectValue>{(v) => (v === NONE ? "Không nhóm" : fieldsOf("group").find((f) => f.key === v)?.label ?? v)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Không nhóm</SelectItem>
                {fieldsOf("group").map((f) => <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </>
      )}
    </form>
  )
}
