"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import { KeyRound, LogOut, Moon, Sun, User as UserIcon } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useAuth } from "@/hooks/use-auth"
import { useAuthStore } from "@/store/auth"
import { logout } from "@/lib/auth-api"
import { useRoleNames } from "@/lib/rbac"
import { useTheme } from "@/lib/theme"
import { getUserDisplayName, getUserEmailTooltip } from "@/lib/user-identity"

/**
 * Chân sidebar (demo giao diện mới): avatar chữ cái + tên + vai trò (bấm mở menu
 * tài khoản) và nút đổi sáng/tối. Đăng xuất mirror ĐÚNG logic của `ShellTopbar`.
 *
 * "Hồ sơ" + "Đổi mật khẩu" cùng trỏ `/settings?tab=profile` — trang đó có cả 2
 * phần trong CÙNG tab "Hồ sơ cá nhân"; không có route riêng cho từng mục.
 */
export function ShellSidebarUser() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { clearAuth } = useAuthStore()
  const { user } = useAuth()
  const roleLabel = useRoleNames()
  const { theme, toggleTheme } = useTheme()

  const displayName = user ? getUserDisplayName(user, "...") : "..."
  const initial = displayName !== "..." ? displayName.trim()[0]?.toUpperCase() ?? "?" : "?"

  const handleLogout = async () => {
    await logout(clearAuth)
    queryClient.clear()
    router.push("/login")
  }

  const dark = theme === "dark"

  return (
    <div className="app-side-me">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              title={getUserEmailTooltip(user)}
              aria-label={`Tài khoản: ${displayName}`}
              className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg p-1 text-left transition-colors hover:bg-[var(--sidebar-accent)]"
            />
          }
        >
          <span className="grid size-7 flex-none place-items-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
            {initial}
          </span>
          <span className="min-w-0 group-data-[collapsible=icon]:hidden">
            <span className="block truncate text-sm leading-tight font-medium text-foreground">{displayName}</span>
            {roleLabel ? (
              <span className="block truncate text-sm leading-tight text-muted-foreground">{roleLabel}</span>
            ) : null}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-56">
          <DropdownMenuItem render={<Link href="/settings?tab=profile" />}>
            <UserIcon className="mr-2 size-4" /> Hồ sơ
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href="/settings?tab=profile" />}>
            <KeyRound className="mr-2 size-4" /> Đổi mật khẩu
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleLogout}>
            <LogOut className="mr-2 size-4" /> Đăng xuất
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        type="button"
        onClick={toggleTheme}
        aria-label={dark ? "Chuyển sang giao diện sáng" : "Chuyển sang giao diện tối"}
        title="Đổi sáng / tối"
        className="app-side-theme group-data-[collapsible=icon]:hidden"
      >
        {dark ? <Sun className="size-[18px]" aria-hidden /> : <Moon className="size-[18px]" aria-hidden />}
      </button>
    </div>
  )
}
