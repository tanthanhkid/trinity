"use client"

import { usePathname, useRouter } from "next/navigation"
import Link from "next/link"
import { ChevronDown, ChevronRight, Home, LogOut, PanelLeft, Search } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useSidebar } from "@/components/ui/sidebar"
import { NotificationsBell } from "@/components/notifications-bell"
import { SocialDueTicker } from "@/components/app-shell/social-due-ticker"
import { openCommandPalette } from "@/components/app-shell/palette-event"
import { useAuth } from "@/hooks/use-auth"
import { logout } from "@/lib/auth-api"
import { resolveBreadcrumb, resolveCustomBreadcrumb } from "@/lib/nav-breadcrumb"
import { useSetupStatus } from "@/hooks/use-setup-status"
import { useCustomNav } from "@/hooks/custom-objects/use-custom-objects"
import { usePermissions, useRoleNames } from "@/lib/rbac"
import { useAuthStore } from "@/store/auth"
import { getUserDisplayName, getUserEmailTooltip } from "@/lib/user-identity"

/**
 * Thanh trên của giao diện v2 — cao 58px, nền TRONG SUỐT hoà
 * vào vùng nội dung (ảnh mẫu không có dải trắng riêng, cũng không có đường kẻ
 * dưới; tách thành thanh trắng làm trang nhìn "nặng đầu").
 *
 * Nút thu gọn sidebar hiện ở MỌI kích thước màn hình — khác v1 (`md:hidden`,
 * xem): v2 thu gọn thành rail 64px chứ không ẩn hẳn, nên luôn còn
 * chỗ bấm để mở lại.
 *
 * Ô "Tìm khách hàng hoặc điều hướng…" là NÚT mở đúng bảng tìm
 * nhanh ⌘K của sidebar (`ShellCommandPalette`: tìm khách qua `GET /contacts` đã
 * RBAC-scope + nhảy tới menu đang thấy) — KHÔNG dựng API tìm kiếm toàn cục mới,
 * và KHÔNG là ô nhập giả. Breadcrumb: nhà › Trinity CRM › [nhóm ›] trang.
 */
export function ShellTopbar() {
  const pathname = usePathname() ?? ""
  const router = useRouter()
  const queryClient = useQueryClient()
  const { clearAuth } = useAuthStore()
  const { user } = useAuth()
  const roleNames = useRoleNames()
  const { toggleSidebar, state, isMobile, openMobile } = useSidebar()
  const navExpanded = isMobile ? openMobile : state === "expanded"

  // Breadcrumb tra thẳng theo pathname (bảng tra dùng chính đường dẫn route).
  const { can } = usePermissions()
  // Chưa dựng quy trình: sidebar không dựng bảng tìm nhanh (⌘K) nên nút tìm ở đây sẽ bấm không làm gì ⇒ ẩn.
  const { status: setupStatus } = useSetupStatus()
  const { data: customNav } = useCustomNav(can("custom_records.view"))
  const { title, parentTitle } = resolveCustomBreadcrumb(pathname, customNav) ?? resolveBreadcrumb(pathname)

  const displayName = user ? getUserDisplayName(user, "...") : "..."
  const initials =
    displayName !== "..."
      ? displayName
          .split(" ")
          .map((w) => w[0])
          .slice(0, 2)
          .join("")
          .toUpperCase()
      : "?"

  const handleLogout = async () => {
    await logout(clearAuth)
    queryClient.clear()
    router.push("/login")
  }

  return (
    <header className="sticky top-0 z-50 flex h-14 flex-none items-center gap-2.5 border-b border-[var(--color-app-line)] bg-white/95 px-5 backdrop-blur-md dark:bg-card/95 max-sm:gap-1 max-sm:px-3">
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={navExpanded ? "Thu gọn menu" : "Mở rộng menu"}
        aria-expanded={navExpanded}
        aria-keyshortcuts="Control+B Meta+B"
        title={navExpanded ? "Thu gọn menu (Ctrl+B)" : "Mở rộng menu (Ctrl+B)"}
        className="grid size-[34px] flex-none place-items-center rounded-lg max-sm:size-11 text-[var(--color-app-ink-2)] transition-colors hover:bg-[var(--color-app-surface-2)]"
      >
        <PanelLeft className="size-[18px]" />
      </button>

      <nav aria-label="breadcrumb" className="flex min-w-0 flex-1 overflow-hidden items-center gap-2 text-sm">
        <Link
          href="/dashboard"
          aria-label="Về Tổng quan"
          className="touch-target grid size-7 flex-none place-items-center rounded-lg max-sm:hidden text-[var(--color-app-ink-2)] transition-colors hover:bg-[var(--color-app-surface-2)]"
        >
          <Home className="size-4" />
        </Link>
        <span className="hidden text-[var(--color-app-line)] sm:inline" aria-hidden>|</span>
        <span className="hidden text-muted-foreground sm:inline">Trinity CRM</span>
        <ChevronRight className="hidden size-3.5 flex-none text-muted-foreground sm:block" aria-hidden />
        {parentTitle ? (
          <>
            <span className="hidden text-muted-foreground md:inline">{parentTitle}</span>
            <ChevronRight className="hidden size-3.5 flex-none text-muted-foreground md:block" aria-hidden />
          </>
        ) : null}
        <h1 className="truncate text-sm font-semibold text-foreground">{title}</h1>
      </nav>

      {setupStatus !== "chua_dung" && (
      <button
        type="button"
        onClick={openCommandPalette}
        aria-label="Tìm khách hàng hoặc điều hướng"
        className="hidden h-[34px] min-w-0 flex-none items-center gap-[7px] rounded-lg border border-[var(--color-app-line)] bg-card px-3 text-left text-sm font-medium text-foreground shadow-[var(--shadow-card)] transition-colors hover:bg-[var(--color-app-surface-2)] md:flex"
      >
        <Search className="size-[18px] flex-none text-muted-foreground" aria-hidden />
        <span className="truncate">Tìm hoặc ra lệnh</span>
        <kbd className="ml-1 rounded-[5px] border border-[var(--color-app-line)] px-1.5 font-sans text-sm font-medium text-muted-foreground">⌘K</kbd>
      </button>
      )}
      <NotificationsBell />
      <SocialDueTicker />
      <span className="mx-1 h-5 w-px bg-border max-sm:hidden" />

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              title={getUserEmailTooltip(user)}
              className="flex items-center gap-2.5 rounded-full py-0.5 pr-1.5 pl-0.5 max-sm:size-11 max-sm:justify-center max-sm:p-0 transition-colors hover:bg-[var(--color-app-surface-2)]"
            />
          }
        >
          <Avatar className="size-8">
            <AvatarFallback className="bg-primary text-sm font-semibold text-primary-foreground">
              {initials}
            </AvatarFallback>
          </Avatar>
          <span className="hidden text-left leading-tight sm:block">
            <span className="block text-sm font-medium">{displayName}</span>
            <span className="block text-sm text-muted-foreground">
              {roleNames}
            </span>
          </span>
          <ChevronDown className="hidden size-4 text-muted-foreground sm:block" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={handleLogout}>
            <LogOut className="mr-2 size-4" />
            Đăng xuất
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  )
}
