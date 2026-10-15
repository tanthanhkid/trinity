"use client"

import Link from "next/link"
import { ChevronDown, Pin } from "lucide-react"
import type { Grants } from "@trinity/rbac"
import {
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar"
import type { ChildMenuItem, MenuItem } from "@/components/nav-config"
import { isChildVisible } from "@/components/nav-visibility"
import { cn } from "@/lib/utils"
import { isItemActive } from "@/components/app-shell/nav-active"
import { AiActionsNavBadge } from "@/components/app-shell/ai-actions-nav-badge"

/**
 * 2 loại mục menu của nhóm "TẤT CẢ" trong sidebar — tách khỏi
 * `sidebar.tsx` để mỗi file dưới 200 dòng theo quy ước của dự án.
 *
 * Dáng (màu/khoảng cách/bo góc/mini-rail) nằm ở `styles/app-sidebar.css`.
 * File này CHỈ dựng DOM + trạng thái — đừng thêm utility Tailwind chỉnh dáng
 * rải rác vào đây.
 */

/**
 * MỘT nguồn icon duy nhất cho mọi mục menu — icon lucide khai ở
 * chính `item.icon`/`child.icon` của `nav-config.ts` (+ `menu-extra.ts` cho mục chèn thêm), render Y HỆT ở "Đã ghim"
 * (`sidebar-pinned-group.tsx`), "Tất cả" (leaf + mục cha ở đây), mục con
 * (`ShellGroupItem` bên dưới) và command palette (`sidebar-command-palette.tsx`).
 *
 * Mọi nhóm dùng icon lucide 16px xám, nét viền — ĐỪNG thêm một bộ icon thứ 2
 * song song với `nav-config.ts`, vì cùng một mục sẽ hiện 2 kiểu vẽ khác nhau.
 */
function NavIcon({ item }: { item: MenuItem | ChildMenuItem }) {
  const Icon = item.icon
  return <Icon />
}

/**
 * Icon ghim hiện khi hover — SIBLING của `SidebarMenuButton`/`SidebarMenuSubButton`
 * (không phải phần tử con lồng bên trong), nên bấm không đi qua cây DOM của
 * Link/Sub-button chứa nó (khác hẳn ca gotcha "chặn nổi bọt sự kiện phá
 * soft-nav" — ở đây không có gì cần chặn).
 */
function PinToggleButton({
  title,
  isPinned,
  onTogglePin,
}: {
  title: string
  isPinned: boolean
  onTogglePin: () => void
}) {
  return (
    <button
      type="button"
      onClick={onTogglePin}
      aria-label={isPinned ? `Bỏ ghim ${title}` : `Ghim ${title}`}
      className={cn(
        "absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-[color:var(--color-app-sidebar-muted)] hover:bg-black/10 group-data-[collapsible=icon]:hidden",
        isPinned ? "opacity-100" : "opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100",
      )}
    >
      <Pin className={cn("size-3", isPinned && "fill-current")} />
    </button>
  )
}

export function ShellLeafItem({
  item,
  activeHref,
  onNavigate,
  isPinned,
  onTogglePin,
}: {
  item: MenuItem
  /** href khớp DÀI NHẤT trong toàn menu — do `sidebar` tính 1 lần. */
  activeHref: string | null
  onNavigate: () => void
  /** Có/không truyền = mục này ghim được (ẩn khi thu gọn icon). */
  isPinned?: boolean
  onTogglePin?: () => void
}) {
  const rawHref = item.href
  if (!rawHref) return null
  // KHÔNG tự xét tiền tố ở đây: 2 mục độc lập cùng "đúng" sẽ làm 2 mục cùng
  // sáng (xem `nav-active.ts`). Chỉ so bằng.
  const active = !item.external && isItemActive(activeHref, rawHref)

  return (
    <SidebarMenuItem className="group/item relative" data-pinned={isPinned ? "" : undefined}>
      <SidebarMenuButton
        render={
          item.external ? (
            <a href={rawHref} target="_blank" rel="noopener noreferrer" onClick={onNavigate} />
          ) : (
            <Link href={rawHref} onClick={onNavigate} />
          )
        }
        isActive={active}
        tooltip={item.title}
        className={cn(active && "app-nav-active")}
      >
        <NavIcon item={item} />
        <span className="truncate">{item.title}</span>
        {item.badgeLabel && <i className="app-nav-tag" data-tone="label">{item.badgeLabel}</i>}
        {item.key === "ai_actions" && <AiActionsNavBadge />}
      </SidebarMenuButton>
      {onTogglePin && (
        <PinToggleButton title={item.title} isPinned={!!isPinned} onTogglePin={onTogglePin} />
      )}
    </SidebarMenuItem>
  )
}

export function ShellGroupItem({
  item,
  activeHref,
  grants,
  isExpanded,
  onToggle,
  onNavigate,
  isChildPinned,
  onToggleChildPin,
}: {
  item: MenuItem & { children: NonNullable<MenuItem["children"]> }
  activeHref: string | null
  grants: Grants
  isExpanded: boolean
  onToggle: () => void
  onNavigate: () => void
  /** Có/không truyền = mục con ghim được. */
  isChildPinned?: (key: string) => boolean
  onToggleChildPin?: (key: string) => void
}) {
  const children = item.children.filter((child: ChildMenuItem) =>
    isChildVisible(child, grants),
  )
  const groupActive = children.some((child) =>
    isItemActive(activeHref, child.href),
  )

  return (
    // `data-open` để CSS xoay mũi tên 180° (demo `.nav-parent.open > a .chev`).
    // Demo LUÔN dùng mũi XUỐNG rồi xoay — đổi hẳn sang ChevronRight như bản
    // trước thì mất chuyển động 0,2s của bản mẫu.
    <SidebarMenuItem data-open={isExpanded ? "" : undefined}>
      <SidebarMenuButton
        onClick={onToggle}
        isActive={groupActive}
        tooltip={item.title}
        className={cn(groupActive && "app-nav-active")}
      >
        <NavIcon item={item} />
        <span className="truncate">{item.title}</span>
        <ChevronDown className="app-nav-chev" />
      </SidebarMenuButton>
      {isExpanded && (
        <SidebarMenuSub>
          {children.map((child) => {
            const href = child.href
            const pinned = isChildPinned?.(child.key)
            return (
              <SidebarMenuSubItem key={child.key} className="group/item relative">
                <SidebarMenuSubButton
                  render={<Link href={href} onClick={onNavigate} />}
                  isActive={isItemActive(activeHref, href, child.href)}
                >
                  <NavIcon item={child} />
                  <span className="truncate">{child.title}</span>
                </SidebarMenuSubButton>
                {onToggleChildPin && (
                  <PinToggleButton
                    title={child.title}
                    isPinned={!!pinned}
                    onTogglePin={() => onToggleChildPin(child.key)}
                  />
                )}
              </SidebarMenuSubItem>
            )
          })}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  )
}
