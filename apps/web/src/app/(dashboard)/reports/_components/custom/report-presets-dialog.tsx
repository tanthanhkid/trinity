"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, Loader2 } from "lucide-react"
import { toast } from "sonner"
import apiClient, { getApiErrorMessage } from "@/lib/api-client"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { CustomReportPreset } from "./custom-report-types"

/**
 * Cài bộ báo cáo mẫu (#25) — mẫu là dữ liệu: mỗi báo cáo chỉ cài khi tổ chức đã có bảng nguồn, trường lấy theo bảng
 * thật; báo cáo đã có (trùng mã) giữ nguyên.
 */
export function ReportPresetsDialog({ open, onOpenChange, onInstalled }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onInstalled: (firstId: string | null) => void
}) {
  const qc = useQueryClient()
  const presets = useQuery<CustomReportPreset[]>({
    queryKey: ["custom-report-presets"],
    queryFn: () => apiClient.get("/reports/custom/presets").then((r) => r.data),
    enabled: open,
  })
  const install = useMutation({
    mutationFn: (key: string) =>
      apiClient.post(`/reports/custom/presets/${key}/install`).then((r) => r.data as { installed: string[] }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["custom-reports"] })
      void qc.invalidateQueries({ queryKey: ["custom-report-defs"] })
      void qc.invalidateQueries({ queryKey: ["custom-report-presets"] })
      toast.success(res.installed.length ? `Đã thêm ${res.installed.length} báo cáo` : "Không có báo cáo mới để thêm")
      onInstalled(res.installed[0] ?? null)
      if (res.installed.length) onOpenChange(false)
    },
    onError: (err) => toast.error(getApiErrorMessage(err, "Không cài được, vui lòng thử lại")),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Báo cáo mẫu</DialogTitle>
          <DialogDescription>Chỉ thêm báo cáo cho những bảng bạn đã có; báo cáo đã có giữ nguyên. Cài xong vẫn sửa được như báo cáo tự tạo.</DialogDescription>
        </DialogHeader>
        {presets.isLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-3">
            {(presets.data ?? []).map((p) => {
              const ready = p.reports.filter((r) => r.installable).length
              return (
                <section key={p.key} className="space-y-2 rounded-[var(--radius)] border border-[var(--border)] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="font-medium">{p.name}</h3>
                      <p className="text-sm text-muted-foreground">{p.description}</p>
                    </div>
                    <Button
                      size="sm"
                      disabled={!ready || install.isPending}
                      onClick={() => install.mutate(p.key)}
                      aria-label={`Cài ${p.name}`}
                    >
                      {install.isPending && install.variables === p.key && <Loader2 className="size-4 animate-spin" />}
                      {ready ? `Thêm ${ready}` : "Đã đủ"}
                    </Button>
                  </div>
                  <ul className="space-y-1 text-sm">
                    {p.reports.map((r) => (
                      <li key={r.id} className="flex items-center justify-between gap-2">
                        <span className={r.source_label ? "" : "text-muted-foreground"}>{r.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {r.installed ? <span className="inline-flex items-center gap-1"><Check className="size-3.5" />Đã có</span>
                            : r.source_label ?? "Chưa có bảng"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
