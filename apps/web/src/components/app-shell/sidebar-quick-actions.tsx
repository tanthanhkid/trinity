"use client"

import { useEffect, useState } from "react"
import { Search } from "lucide-react"
import { ShellCommandPalette } from "@/components/app-shell/sidebar-command-palette"
import { OPEN_PALETTE_EVENT } from "@/components/app-shell/palette-event"
import type { FlatMenuEntry } from "@/components/app-shell/menu-resolve"

/**
 * Ô "Tìm hoặc ra lệnh ⌘K" ở đầu sidebar (theo demo giao diện mới). "Thêm khách"
 * (trước là nút + cạnh ô tìm) nay là một lệnh trong bảng ⌘K, vẫn chỉ hiện khi có
 * quyền `contacts.create` + tính năng `contacts` bật.
 */
export function ShellQuickActions({ navEntries }: { navEntries: FlatMenuEntry[] }) {
  const [paletteOpen, setPaletteOpen] = useState(false)

  useEffect(() => {
    // Ô tìm kiếm ở thanh trên (topbar) mở CÙNG bảng tìm này qua sự kiện, để chỉ có
    // 1 nơi giữ trạng thái/nội dung bảng — xem `components/app-shell/palette-event.ts`.
    const onOpen = () => setPaletteOpen(true)
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen)
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpen)
    }
  }, [])

  return (
    <div className="px-0.5 pb-2 group-data-[collapsible=icon]:px-0">
      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        title="Tìm hoặc ra lệnh (⌘K)"
        aria-label="Tìm kiếm"
        aria-keyshortcuts="Meta+K Control+K"
        className="app-side-search"
      >
        <Search className="size-[18px] flex-none" aria-hidden />
        <span className="truncate group-data-[collapsible=icon]:hidden">Tìm hoặc ra lệnh</span>
        <kbd className="group-data-[collapsible=icon]:hidden">⌘K</kbd>
      </button>
      <ShellCommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        navEntries={navEntries}
      />
    </div>
  )
}
