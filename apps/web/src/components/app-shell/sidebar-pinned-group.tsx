"use client"

import Link from "next/link"
import { Pin } from "lucide-react"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { ShellGroupLabel } from "@/components/app-shell/sidebar-group-label"
import { resolvePinnedEntries, type FlatMenuEntry } from "@/components/app-shell/menu-resolve"
import { isItemActive } from "@/components/app-shell/nav-active"
import { cn } from "@/lib/utils"

/**
 * Nhóm "Đã ghim". `visibleFlatEntries` PHẢI là danh sách đã lọc
 * qua `isItemVisible`/`isChildVisible` của role HIỆN TẠI — xem
 * `resolvePinnedEntries` để hiểu vì sao mục ghim ngoài quyền tự biến mất mà
 * không cần thêm 1 lớp RBAC riêng ở đây.
 */
export function ShellPinnedGroup({
  pinnedKeys,
  visibleFlatEntries,
  activeHref,
  onTogglePin,
  onNavigate,
}: {
  pinnedKeys: string[]
  visibleFlatEntries: FlatMenuEntry[]
  activeHref: string | null
  onTogglePin: (key: string) => void
  onNavigate: () => void
}) {
  const entries = resolvePinnedEntries(pinnedKeys, visibleFlatEntries)
  if (entries.length === 0) return null

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <ShellGroupLabel>Đã ghim</ShellGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {entries.map((entry) => {
            const active = isItemActive(activeHref, entry.href)
            return (
              <SidebarMenuItem key={entry.key} className="group/pin relative">
                <SidebarMenuButton
                  render={<Link href={entry.href} onClick={onNavigate} />}
                  isActive={active}
                  tooltip={entry.title}
                  className={cn(active && "app-nav-active")}
                >
                  <entry.icon />
                  <span className="truncate">{entry.title}</span>
                </SidebarMenuButton>
                {/* Nút ghim là SIBLING của SidebarMenuButton/Link ở trên (không
                    phải phần tử con lồng bên trong nó) — bấm ở đây không đi
                    qua cây DOM của Link nên không cần chặn nổi bọt sự kiện gì
                    cả (khác hẳn ca Link KHÔNG bọc nút này). */}
                <button
                  type="button"
                  onClick={() => onTogglePin(entry.key)}
                  aria-label={`Bỏ ghim ${entry.title}`}
                  className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-[color:var(--color-app-sidebar-muted)] opacity-0 hover:bg-black/10 focus-visible:opacity-100 group-hover/pin:opacity-100"
                >
                  <Pin className="size-3 fill-current" />
                </button>
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
