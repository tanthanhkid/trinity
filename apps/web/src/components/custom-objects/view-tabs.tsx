"use client"

import Link from "next/link"
import { CalendarDays, KanbanSquare, List, Table2 } from "lucide-react"
import { useCustomViews } from "@/hooks/custom-objects/use-custom-views"
import { cn } from "@/lib/utils"

type ViewTab = { key: string | null; label: string; href: string; type: string }

/**
 * Các tab của một bảng: view đã dựng (kanban/lịch/bảng/danh sách) + tab "Danh sách" mặc định CHỈ khi chưa có view
 * kiểu danh sách (có rồi thì hai tab là một màn, lặp — #31). Không bỏ view nào.
 */
export function viewTabs(objectKey: string, views: { key: string; label: string; href: string; type: string }[]): ViewTab[] {
  const own = views.map((v) => ({ key: v.key as string | null, label: v.label, href: v.href, type: v.type }))
  return own.some((v) => v.type === "list") ? own : [{ key: null, label: "Danh sách", href: `/x/${objectKey}`, type: "list" }, ...own]
}

/** Thanh chuyển màn của một bảng — chỉ hiện khi có từ 2 màn để chuyển (#31); 1 màn thì ẩn cả thanh. */
export function ViewTabs({ objectKey, active }: { objectKey: string; active: string | null }) {
  const { data } = useCustomViews(objectKey)
  const tabs = viewTabs(objectKey, data ?? [])
  if (tabs.length < 2) return null
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
