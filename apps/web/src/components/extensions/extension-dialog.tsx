"use client"

import { useState } from "react"
import { AlertTriangle, Loader2, ShieldAlert } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { formatDateTimeVn } from "@/lib/format"
import { KIND_LABEL, REVIEW_LABEL, STATUS_LABEL, STATUS_VARIANT, describePermissions, extensionErrorMessage, type Extension, type ExtensionVersion } from "@/lib/extensions"
import { useExtension, useExtensionAction, useExtensionVersion, type ExtensionAction } from "@/hooks/extensions/use-extensions"
import { ExtensionLogs } from "./extension-logs"

type Tab = "code" | "logs"

/** Nút hành động hợp lệ cho phiên bản đang xem (BE kiểm lại tất cả — FE chỉ ẩn/hiện). Chỉ MỘT nút đặc: Duyệt hoặc Chạy. */
function actionsFor(e: Extension, v: ExtensionVersion): { primary: { action: ExtensionAction; label: string } | null; secondary: { action: ExtensionAction; label: string }[] } {
  const secondary: { action: ExtensionAction; label: string }[] = []
  let primary: { action: ExtensionAction; label: string } | null = null
  if (v.review_status === "draft") {
    primary = { action: "approve", label: `Duyệt bản ${v.version}` }
    secondary.push({ action: "reject", label: "Từ chối" })
  } else if (v.review_status === "approved" && e.kind !== "api") {
    const older = e.active_version !== null && v.version < e.active_version
    if (e.status === "disabled") secondary.push({ action: "deploy", label: `Chọn bản ${v.version} (vẫn tắt)` })
    else if (e.active_version !== v.version) {
      const a = { action: older ? ("rollback" as const) : ("deploy" as const), label: older ? `Quay lui về bản ${v.version}` : `Chạy bản ${v.version}` }
      if (older) secondary.push(a)
      else primary = a
    }
  }
  if (e.status === "disabled" && e.active_version !== null) primary = primary ?? { action: "enable", label: "Bật lại" }
  if (e.status === "active") secondary.push({ action: "disable", label: "Tắt chương trình con" })
  return { primary, secondary }
}

export function ExtensionDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const one = useExtension(id)
  const ext = one.data?.extension
  const versions = one.data?.versions ?? []
  const [picked, setPicked] = useState<number | null>(null)
  const [tab, setTab] = useState<Tab>("code")
  const [reason, setReason] = useState("")
  const [rejecting, setRejecting] = useState(false)
  const act = useExtensionAction()
  const shown = picked ?? (ext ? (versions.find((v) => v.review_status === "draft")?.version ?? ext.active_version ?? ext.latest_version) : null)
  const detail = useExtensionVersion(id, shown)
  const v = detail.data?.version ?? versions.find((x) => x.version === shown)
  const acts = ext && v ? actionsFor(ext, v) : { primary: null, secondary: [] }

  function run(action: ExtensionAction) {
    if (action === "reject" && !rejecting) return setRejecting(true)
    act.mutate({ id, action, version: shown ?? undefined, reason: reason.trim() || undefined }, {
      onSuccess: () => { toast.success(action === "approve" ? "Đã duyệt — chưa chạy cho tới khi bạn bấm Chạy" : "Đã cập nhật"); setRejecting(false); setReason("") },
    })
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !act.isPending) onClose() }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <span className="break-words">{ext?.name ?? "Chương trình con"}</span>
            {ext && <Badge variant={STATUS_VARIANT[ext.status]}>{STATUS_LABEL[ext.status]}</Badge>}
          </DialogTitle>
          <DialogDescription>{ext ? `${KIND_LABEL[ext.kind]} · mã ${ext.key}` : "Đang tải..."}</DialogDescription>
        </DialogHeader>
        {one.isLoading && <Loader2 className="size-4 animate-spin" aria-label="Đang tải" />}
        {one.isError && <p className="text-sm text-red-600" role="alert">Không tìm thấy chương trình con này.</p>}
        {ext && (
          <>
            <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-900" role="note">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              Mã do trợ lý AI viết. Hãy đọc kỹ mô tả, các quyền xin và mã trước khi duyệt. Duyệt xong chương trình con CHƯA chạy — cần bấm Chạy; lỗi liên tục sẽ tự tắt.
            </p>
            {ext.description && <p className="whitespace-pre-wrap break-words text-sm">{ext.description}</p>}
            <div className="flex flex-wrap gap-2" role="group" aria-label="Chọn phiên bản">
              {versions.map((x) => (
                <Button key={x.version} size="sm" variant={x.version === shown ? "soft" : "outline"} aria-pressed={x.version === shown} onClick={() => setPicked(x.version)}>
                  Bản {x.version} · {REVIEW_LABEL[x.review_status]}{x.version === ext.active_version ? " · đang chạy" : ""}
                </Button>
              ))}
            </div>
            <div className="flex gap-2" role="group" aria-label="Nội dung">
              <Button size="sm" variant={tab === "code" ? "soft" : "outline"} aria-pressed={tab === "code"} onClick={() => setTab("code")}>Quyền xin &amp; mã</Button>
              <Button size="sm" variant={tab === "logs" ? "soft" : "outline"} aria-pressed={tab === "logs"} onClick={() => setTab("logs")}>Nhật ký chạy</Button>
            </div>
            {tab === "logs" ? <ExtensionLogs id={id} /> : v && (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">Gửi lúc {formatDateTimeVn(v.created_at)}{v.note ? ` · ${v.note}` : ""}{v.review_note ? ` · Lý do từ chối: ${v.review_note}` : ""}</p>
                <ul className="list-disc space-y-1 pl-5 text-sm" data-testid="extension-permissions">
                  {describePermissions(v.manifest, ext.kind).map((l) => <li key={l} className="break-words">{l}</li>)}
                </ul>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs" data-testid="extension-code">{v.code ?? "Đang tải mã..."}</pre>
              </div>
            )}
            {ext.status === "disabled" && ext.disabled_reason && <p className="flex items-start gap-2 text-sm text-red-700" role="alert"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> <span className="break-words">{ext.disabled_reason}</span></p>}
            {rejecting && <label className="block space-y-1 text-xs font-medium">Lý do từ chối (trợ lý AI sẽ đọc để sửa)<Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} autoComplete="off" /></label>}
            {act.isError && <p className="flex items-start gap-2 text-sm text-red-700" role="alert"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> <span className="break-words">{extensionErrorMessage(act.error, "Không thực hiện được")}</span></p>}
            <DialogFooter>
              {acts.secondary.map((a) => <Button key={a.action} type="button" variant="outline" disabled={act.isPending} onClick={() => run(a.action)}>{a.label}</Button>)}
              {acts.primary && <Button type="button" disabled={act.isPending} onClick={() => run(acts.primary!.action)}>{act.isPending && <Loader2 className="animate-spin" aria-hidden />} {acts.primary.label}</Button>}
              <Button type="button" variant="ghost" onClick={onClose}>Đóng</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
