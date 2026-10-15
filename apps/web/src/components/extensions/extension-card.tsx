"use client"

import { Code2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { formatDateTimeVn } from "@/lib/format"
import { KIND_LABEL, STATUS_LABEL, STATUS_VARIANT, type Extension } from "@/lib/extensions"

/** 1 chương trình con trong danh sách. Tên/mô tả do trợ lý AI soạn ⇒ chỉ hiển thị dạng text. */
export function ExtensionCard({ ext, onOpen }: { ext: Extension; onOpen: () => void }) {
  const waiting = ext.status === "draft" || (ext.active_version !== null && ext.latest_version > ext.active_version)
  return (
    <Card className="rounded-2xl" data-testid="extension-card">
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{KIND_LABEL[ext.kind]}</Badge>
          <Badge variant={STATUS_VARIANT[ext.status]}>{STATUS_LABEL[ext.status]}</Badge>
          {waiting && ext.status !== "draft" && <Badge variant="soft">Có bản mới</Badge>}
        </div>
        <p className="break-words text-sm font-medium">{ext.name}</p>
        {ext.description && <p className="line-clamp-2 break-words text-xs text-muted-foreground">{ext.description}</p>}
        <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <Code2 className="size-3.5" aria-hidden />
          <span className="break-all">{ext.key}</span>
          <span>· {ext.active_version ? `đang chạy bản ${ext.active_version}` : "chưa chạy"} · mới nhất bản {ext.latest_version}</span>
          <span>· cập nhật {formatDateTimeVn(ext.updated_at)}</span>
        </p>
        {ext.status === "disabled" && ext.disabled_reason && <p className="break-words text-xs text-red-700">{ext.disabled_reason}</p>}
        <div className="flex justify-end">
          <Button variant="outline" size="sm" className="max-sm:h-11" onClick={onOpen}>{waiting ? "Xem & duyệt" : "Xem chi tiết"}</Button>
        </div>
      </CardContent>
    </Card>
  )
}
