"use client"

import Link from "next/link"
import { CalendarDays, KanbanSquare, List, Table2 } from "lucide-react"
import { useCustomViews } from "@/hooks/custom-objects/use-custom-views"
import { cn } from "@/lib/utils"

/** Thanh chuyển màn của một bảng: Danh sách mặc định + các view (kanban/lịch/bảng/danh sách) đã dựng. Không có view ⇒ không hiện gì. */
export function ViewTabs({ objectKey, active }: { objectKey: string; active: string | null }) {
  const { data } = useCustomViews(objectKey)
  if (!data || data.length === 0) return null
  const tabs = [{ key: null as string | null, label: "Danh sách", href: `/x/${objectKey}`, type: "list" }, ...data.map((v) => ({ key: v.key, label: v.label, href: v.href, type: v.type as string }))]
  return (
    <nav aria-label="Màn xem" className="flex flex-wrap gap-1.5">
      {tabs.map((t) => {
        const on = t.key === active
        const Icon = t.type === "kanban" ? KanbanSquare : t.type === "calendar" ? CalendarDays : t.type === "table" ? Table2 : List
        return (
          <Link key={t.href} href={t.href} aria-current={on ? "page" : undefined}
            className={cn("inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-3 text-sm", on ? "border-primary bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-muted")}>
            <Icon className="size-4" aria-hidden /> {t.label}
          </Link>
        )
      })}
    </nav>
  )
}
