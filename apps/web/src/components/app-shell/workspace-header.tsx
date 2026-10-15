"use client"

import Link from "next/link"

/**
 * Khối "workspace" ở đỉnh sidebar (demo giao diện mới): logo lục giác + "Trinity"
 * + dòng phụ. Bấm về Tổng quan. Menu tài khoản (Hồ sơ/Đổi mật khẩu/Đăng xuất)
 * chuyển xuống hàng người dùng ở chân sidebar — `sidebar-user.tsx`.
 */
export function ShellWorkspaceHeader() {
  return (
    <Link href="/dashboard" className="app-side-ws" aria-label="Trinity — về Tổng quan">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo/trinity-mark.png" alt="" className="h-[30px] w-[26px] flex-none object-contain" />
      <span className="min-w-0 group-data-[collapsible=icon]:hidden">
        <b className="block truncate text-[15px] leading-tight font-semibold text-foreground">Trinity</b>
        <small className="block truncate text-sm leading-tight text-muted-foreground">Quản trị tập trung</small>
      </span>
    </Link>
  )
}
