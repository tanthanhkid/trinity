"use client"

import type { ComponentProps } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

/**
 * Khung tab dùng chung — giao diện mới 10/2026: "tab nhanh" canh trái, mục đang mở là
 * nền xám nhạt (`--muted`), KHÔNG gạch chân (cùng kiểu tab ở chi tiết khách / Khách hàng).
 *
 * Chỉ là wrapper className quanh `components/ui/tabs` (Base UI) — KHÔNG viết lại logic Tabs.
 *
 * Dùng cho các màn có menu tab ngang: Chấm công, Lương, Quản lý, POS, Báo cáo, Bảng tin.
 */

/** Hàng tab nhanh của giao diện mới: canh trái, không viền dưới, các nút nằm sát nhau. */
export const QUICK_TABS_LIST = "h-auto w-full justify-start gap-1 border-0 bg-transparent p-0"

/** 1 tab nhanh — cùng kiểu tab của chi tiết khách / Khách hàng: nền xám khi chọn, không gạch chân. */
export const QUICK_TAB =
  "h-9 flex-none rounded-lg px-3 text-sm font-medium after:hidden data-active:bg-[var(--muted)]! data-active:text-foreground hover:bg-[var(--muted)] max-sm:h-11 dark:data-active:border-transparent"

export const ShellTabs = Tabs
export const ShellTabsContent = TabsContent

export function ShellTabsList({
  className,
  ...props
}: ComponentProps<typeof TabsList>) {
  return <TabsList variant="line" layout="wrap" className={cn(QUICK_TABS_LIST, className)} {...props} />
}

export function ShellTabsTrigger({
  className,
  ...props
}: ComponentProps<typeof TabsTrigger>) {
  return <TabsTrigger className={cn(QUICK_TAB, className)} {...props} />
}
