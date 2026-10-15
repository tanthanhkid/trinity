"use client"

import { useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { AlertTriangle, Code2, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { extensionsDisabled, type Extension } from "@/lib/extensions"
import { useExtensions } from "@/hooks/extensions/use-extensions"
import { ExtensionCard } from "./extension-card"
import { ExtensionDialog } from "./extension-dialog"

type Filter = "all" | "waiting" | "active" | "disabled"
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "Tất cả" },
  { value: "waiting", label: "Chờ duyệt" },
  { value: "active", label: "Đang chạy" },
  { value: "disabled", label: "Đã tắt" },
]
const isWaiting = (e: Extension) => e.status === "draft" || (e.active_version !== null && e.latest_version > e.active_version)
const matches = (e: Extension, f: Filter) => f === "all" || (f === "waiting" ? isWaiting(e) : e.status === f)

function parseId(v: string | null): number | null {
  const n = v && /^\d{1,10}$/.test(v) ? Number(v) : NaN
  return Number.isInteger(n) && n >= 1 && n <= 2_147_483_647 ? n : null
}

/**
 * Chương trình con: danh sách + xem mã/quyền xin + Duyệt / Từ chối / Chạy / Tắt / Bật lại / Quay lui + nhật ký chạy.
 * FE chỉ hiển thị — BE kiểm quyền (`extensions.view` / `extensions.approve`) và cờ tính năng (tắt ⇒ 404 ⇒ thông báo "chưa bật").
 */
export function ExtensionsScreen() {
  const router = useRouter()
  const idParam = parseId(useSearchParams().get("id"))
  const [filter, setFilter] = useState<Filter>("all")
  const [localId, setLocalId] = useState<number | null>(null)
  const openId = localId ?? idParam
  const list = useExtensions()
  const rows = (list.data ?? []).filter((e) => matches(e, filter))

  if (list.isError && extensionsDisabled(list.error)) {
    return <EmptyState icon={Code2} message="Tính năng Chương trình con chưa được bật trên hệ thống này." />
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Trợ lý AI của bạn có thể viết thêm tính năng nhỏ (đồng bộ dữ liệu theo lịch, công cụ riêng…). Mỗi chương trình con chạy tách riêng, lỗi không ảnh hưởng hệ thống chính, và chỉ chạy sau khi bạn đọc và duyệt.</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Lọc chương trình con">
        {FILTERS.map((f) => <Button key={f.value} size="sm" variant={filter === f.value ? "soft" : "outline"} aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>{f.label}</Button>)}
      </div>
      {list.isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Đang tải...</div>}
      {list.isError && <Card><CardContent className="flex items-center gap-2 py-4 text-sm text-red-600" role="alert"><AlertTriangle className="size-4" /> Không tải được danh sách. Vui lòng thử lại.</CardContent></Card>}
      {list.isSuccess && rows.length === 0 && <EmptyState icon={Code2} message={filter === "all" ? "Chưa có chương trình con nào. Hãy nhờ trợ lý AI của bạn tạo." : "Không có chương trình con nào trong mục này."} />}
      <div className="grid gap-3 lg:grid-cols-2">
        {rows.map((e) => <ExtensionCard key={e.id} ext={e} onOpen={() => setLocalId(e.id)} />)}
      </div>
      {openId !== null && <ExtensionDialog key={openId} id={openId} onClose={() => { setLocalId(null); if (idParam !== null) router.replace("/extensions") }} />}
    </div>
  )
}
