"use client"

import Link from "next/link"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { ShellGroupLabel } from "@/components/app-shell/sidebar-group-label"
import { formatRelativeTimeVn } from "@/lib/nav-time"
import type { RecentContact } from "@/hooks/use-recent-contacts"

/** Màu avatar chữ cái xoay vòng theo id — thuần trang trí, không mang RBAC. */
const AVATAR_TONES = [
  "bg-[var(--color-app-tag-blue-bg)] text-[var(--color-app-tag-blue-ink)]",
  "bg-[var(--color-app-tag-teal-bg)] text-[var(--color-app-tag-teal-ink)]",
  "bg-[var(--color-app-tag-amber-bg)] text-[var(--color-app-tag-amber-ink)]",
  "bg-[var(--color-app-tag-red-bg)] text-[var(--color-app-tag-red-ink)]",
  "bg-[var(--color-app-tag-violet-bg)] text-[var(--color-app-tag-violet-ink)]",
]

function initialOf(name: string | null): string {
  const trimmed = name?.trim()
  return trimmed ? trimmed[0]!.toUpperCase() : "?"
}

/**
 * Nhóm "Khách gần đây". BE (`GET /contacts/recent`) đã lọc theo
 * phạm vi `contacts.view` (hook `useRecentContacts` không gọi API khi thiếu quyền) — component
 * chỉ việc KHÔNG RENDER khi danh sách rỗng, không cần lọc thêm ở đây.
 */
export function ShellRecentGroup({
  contacts,
  onNavigate,
}: {
  contacts: RecentContact[]
  onNavigate: () => void
}) {
  if (contacts.length === 0) return null

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <ShellGroupLabel>Khách gần đây</ShellGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {contacts.map((c, i) => (
            <SidebarMenuItem key={c.id}>
              <SidebarMenuButton
                render={<Link href={`/contacts/${c.id}`} onClick={onNavigate} />}
                tooltip={c.full_name ?? `Khách #${c.id}`}
              >
                <span
                  className={`flex size-6 flex-none items-center justify-center rounded-full text-sm font-semibold ${AVATAR_TONES[i % AVATAR_TONES.length]}`}
                >
                  {initialOf(c.full_name)}
                </span>
                <span className="min-w-0 flex-1 truncate">{c.full_name ?? `Khách #${c.id}`}</span>
                <span className="flex-none text-sm text-[color:var(--color-app-sidebar-muted)]">
                  {formatRelativeTimeVn(c.viewed_at)}
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
