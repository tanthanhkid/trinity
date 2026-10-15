"use client"

import { useState } from "react"
import { CheckCircle2, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { useApplyCustomTemplate, useCustomTemplates } from "@/hooks/custom-objects/use-custom-objects"
import { getApiErrorMessage } from "@/lib/api-client"
import { usePermissions } from "@/lib/rbac"

/**
 * Áp MẪU dựng sẵn theo ngành (Trung tâm giáo dục, Bất động sản, Bán lẻ / dịch vụ, Phòng khám — danh sách lấy từ
 * BE, chọn một mẫu rồi áp; đã nối liên kết + công thức). Áp lại KHÔNG nhân đôi: tính năng đã có (cùng mã) được giữ nguyên. Dữ liệu mẫu là dữ liệu GIẢ, xoá được bất cứ lúc nào.
 */
export function TemplateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { can } = usePermissions()
  const templates = useCustomTemplates(open)
  const apply = useApplyCustomTemplate()
  const [withSamples, setWithSamples] = useState(false)
  const canSamples = can("custom_records.manage")
  const [picked, setPicked] = useState<string | null>(null)
  const list = templates.data ?? []
  const tpl = list.find((t) => t.key === picked) ?? list[0]

  function submit(key: string) {
    apply.mutate(
      { template: key, withSampleData: withSamples && canSamples },
      {
        onSuccess: (r) => {
          toast.success(r.created.length ? `Đã tạo ${r.created.length} tính năng${r.sample_records ? ` và ${r.sample_records} bản ghi mẫu` : ""}` : "Các tính năng của mẫu đã có sẵn — không thay đổi gì")
          onOpenChange(false)
        },
        onError: (e) => toast.error(getApiErrorMessage(e, "Không áp được mẫu, vui lòng thử lại")),
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!apply.isPending) onOpenChange(o) }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Dùng mẫu theo ngành</DialogTitle>
          <DialogDescription>Tạo sẵn các tính năng, trường dữ liệu, liên kết và công thức. Tính năng đã có cùng mã sẽ được giữ nguyên.</DialogDescription>
        </DialogHeader>
        {templates.isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang tải…</div>}
        {templates.isError && <p className="text-sm text-destructive">Không tải được danh sách mẫu.</p>}
        {tpl && (
          <div className="space-y-3">
            <div role="radiogroup" aria-label="Chọn mẫu ngành" className="grid grid-cols-1 gap-1.5 sm:grid-cols-2" data-testid="template-picker">
              {list.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="radio"
                  aria-checked={t.key === tpl.key}
                  onClick={() => setPicked(t.key)}
                  className={`rounded-lg border px-3 py-2 text-left text-sm font-medium max-sm:min-h-11 ${t.key === tpl.key ? "border-primary bg-primary/5" : "hover:bg-muted"}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">{tpl.description}</p>
            <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {tpl.objects.map((o) => (
                <li key={o.key} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
                  <span className="font-medium">{o.label}</span>
                  {o.applied ? <Badge variant="outline"><CheckCircle2 className="mr-1 size-3" /> Đã có</Badge> : <span className="text-xs text-muted-foreground">Sẽ tạo</span>}
                </li>
              ))}
            </ul>
            <label className="flex items-center justify-between gap-3 rounded-lg border p-3 max-sm:min-h-14">
              <span>
                <span className="block font-medium">Kèm dữ liệu mẫu</span>
                <span className="block text-xs text-muted-foreground">
                  {canSamples ? "Vài bản ghi GIẢ (tên “… Mẫu 01”) để thử liên kết và công thức. Chỉ sinh cho tính năng MỚI tạo; xoá được bất cứ lúc nào." : "Cần thêm quyền “Thêm/sửa dữ liệu của tính năng tuỳ biến”."}
                </span>
              </span>
              <Switch checked={withSamples && canSamples} disabled={!canSamples} onCheckedChange={setWithSamples} aria-label="Kèm dữ liệu mẫu" />
            </label>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={apply.isPending}>Huỷ</Button>
          <Button type="button" onClick={() => tpl && submit(tpl.key)} disabled={apply.isPending || !tpl}>
            {apply.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />} Áp mẫu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
