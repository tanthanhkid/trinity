"use client"

import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button, buttonVariants } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Download, Loader2, Upload, AlertTriangle } from "lucide-react"
import apiClient from "@/lib/api-client"
import { cn } from "@/lib/utils"
import { formatMonth } from "./payroll-payslips-shared"
// ============ Dialog Nhập phiếu lương từ Excel ============
interface ImportChangeItem {
  header: string
  field: string
  before: string | null
  after: string
}
interface ImportPreviewRowFE {
  employee_code: string
  employee_name: string | null
  payslip_id: number | null
  payslip_status: string | null
  changes: ImportChangeItem[]
  skipped: boolean
  skip_reason?: string
}

export function ImportPayslipsDialog({
  month, onClose, onImported,
}: {
  month: string
  onClose: () => void
  onImported: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<ImportPreviewRowFE[] | null>(null)
  const [applied, setApplied] = useState<ImportPreviewRowFE[] | null>(null)
  const [downloadingTemplate, setDownloadingTemplate] = useState(false)

  async function downloadTemplate() {
    setDownloadingTemplate(true)
    try {
      const res = await apiClient.get("/payslips/import-template", {
        params: { month },
        responseType: "blob",
      })
      const blob = res.data as Blob
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `mau-nhap-phieu-luong-${month}.xlsx`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch {
      toast.error("Không thể tải file mẫu. Vui lòng thử lại.")
    } finally {
      setDownloadingTemplate(false)
    }
  }

  const previewMutation = useMutation({
    mutationFn: async (f: File) => {
      const formData = new FormData()
      formData.append("file", f)
      const res = await apiClient.post<ImportPreviewRowFE[]>(
        "/payslips/import/preview",
        formData,
        { params: { month }, headers: { "Content-Type": "multipart/form-data" } },
      )
      return res.data
    },
    onSuccess: (rows) => {
      setPreview(rows)
      setApplied(null)
      if (rows.length === 0) toast.info("File không có dòng hợp lệ (kiểm tra cột Mã nhân viên).")
    },
    onError: () => toast.error("Không thể đọc file. Kiểm tra đúng file Excel Template."),
  })

  const applyMutation = useMutation({
    mutationFn: async (f: File) => {
      const formData = new FormData()
      formData.append("file", f)
      const res = await apiClient.post<ImportPreviewRowFE[]>(
        "/payslips/import/apply",
        formData,
        { params: { month }, headers: { "Content-Type": "multipart/form-data" } },
      )
      return res.data
    },
    onSuccess: (rows) => {
      setApplied(rows)
      const okCount = rows.filter((r) => !r.skipped).length
      const skipCount = rows.filter((r) => r.skipped).length
      toast.success(
        `Đã cập nhật ${okCount} phiếu lương tháng ${formatMonth(month)}` +
          (skipCount > 0 ? `, bỏ qua ${skipCount} dòng.` : "."),
      )
      onImported()
    },
    onError: () => toast.error("Không thể áp dụng import. Vui lòng thử lại."),
  })

  function handleFileChange(f: File | null) {
    setFile(f)
    setPreview(null)
    setApplied(null)
    if (f) previewMutation.mutate(f)
  }

  const rows = applied ?? preview
  const isBusy = previewMutation.isPending || applyMutation.isPending

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="flex max-h-[85vh] flex-col rounded-2xl sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Nhập phiếu lương từ Excel — Tháng {formatMonth(month)}</DialogTitle>
          <DialogDescription>
            Xác định nhân viên theo <strong>Mã nhân viên</strong>. Chỉ cập nhật phiếu lương của
            tháng đang chọn, bỏ qua phiếu đã duyệt/đã trả.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-3 overflow-y-auto pr-1">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => void downloadTemplate()} disabled={downloadingTemplate}>
              {downloadingTemplate ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
              Tải file mẫu (đã điền dữ liệu hiện tại)
            </Button>
            <label
              className={cn(
                buttonVariants({ variant: "outline" }),
                "h-11 cursor-pointer",
              )}
            >
              <Upload className="mr-2 h-4 w-4" />
              Chọn file Excel…
              <input
                type="file"
                accept=".xlsx"
                className="hidden"
                onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
              />
            </label>
            {file && <span className="text-sm text-muted-foreground">{file.name}</span>}
          </div>

          {isBusy && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Đang xử lý…
            </p>
          )}

          {rows && rows.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                {applied ? "Kết quả import:" : "Xem trước thay đổi:"}{" "}
                <strong>{rows.filter((r) => !r.skipped).length}</strong> dòng{" "}
                {applied ? "đã cập nhật" : "sẽ cập nhật"},{" "}
                <strong>{rows.filter((r) => r.skipped).length}</strong> dòng bỏ qua.
              </p>
              <div className="max-h-[40vh] overflow-y-auto rounded-lg border">
                {rows.map((r, idx) => (
                  <div key={idx} className="border-b px-3 py-2 text-sm last:border-b-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">
                        {r.employee_code} {r.employee_name ? `— ${r.employee_name}` : ""}
                      </span>
                      {r.skipped ? (
                        <span className="flex items-center gap-1 text-xs text-amber-700">
                          <AlertTriangle className="h-3 w-3" /> Bỏ qua
                        </span>
                      ) : (
                        <span className="text-xs text-[var(--color-app-primary-ink)]">
                          {r.changes.length} thay đổi
                        </span>
                      )}
                    </div>
                    {r.skipped && r.skip_reason && (
                      <p className="text-xs text-amber-700">{r.skip_reason}</p>
                    )}
                    {!r.skipped && r.changes.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                        {r.changes.map((c, i) => (
                          <li key={i}>
                            {c.header}: {c.before ?? "—"} → <strong>{c.after}</strong>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Đóng</Button>
          {preview && !applied && (
            <Button
              disabled={!file || isBusy || preview.every((r) => r.skipped)}
              onClick={() => file && applyMutation.mutate(file)}
            >
              {applyMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Áp dụng import
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

