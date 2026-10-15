"use client"

import { useSearchParams } from "next/navigation"
import { Loader2, Newspaper } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { ShellPageHeader } from "@/components/app-shell/page-header"
import { useMyBriefings, type BriefingRow } from "@/hooks/use-briefings"

const SLOT_LABEL = { morning: "Sáng", evening: "Chiều" } as const

function BriefingCard({ b, open }: { b: BriefingRow; open: boolean }) {
  return (
    <Card className={open ? "ring-2 ring-primary/40" : undefined} id={`briefing-${b.id}`}>
      <CardContent className="space-y-3 p-5">
        <div className="flex items-center justify-between gap-2">
          <p className="font-semibold">{b.title}</p>
          <span className="text-xs text-muted-foreground">{SLOT_LABEL[b.slot]} · {b.day}</span>
        </div>
        {/* Bản mẫu bắt đầu bằng dòng tiêu đề; bản agent viết (MCP save_briefing) có thể không — chỉ bỏ dòng đầu khi trùng tiêu đề. */}
        <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{(b.text.startsWith(b.title) ? b.text.slice(b.title.length) : b.text).trim()}</pre>
      </CardContent>
    </Card>
  )
}

/** Danh sách bản tin CỦA MÌNH, mở sẵn bản tin trong `?id=` (link từ chuông thông báo). */
export function BriefingsScreen() {
  const idParam = Number(useSearchParams().get("id"))
  const { data, isLoading, isError } = useMyBriefings()
  return (
    <div className="space-y-4">
      <ShellPageHeader title="Bản tin" icon={Newspaper} description="Tổng hợp số liệu sáng và chiều theo phạm vi quyền của bạn" />
      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Đang tải...
        </div>
      )}
      {isError && <p className="text-sm text-destructive">Không tải được bản tin.</p>}
      {data && data.length === 0 && <EmptyState icon={Newspaper} message="Chưa có bản tin nào. Bản tin được gửi tự động mỗi sáng và chiều khi công ty bật tính năng này." />}
      <div className="space-y-3">
        {data?.map((b) => <BriefingCard key={b.id} b={b} open={b.id === idParam} />)}
      </div>
    </div>
  )
}
