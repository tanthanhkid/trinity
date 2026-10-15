"use client"

import { FileSpreadsheet, Loader2, MoreHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/**
 * menu "⋯" chứa "Xuất Excel" CHỈ trên điện thoại (<640px);
 * desktop vẫn dùng nút "Xuất Excel" gốc trong thanh lọc.
 */
export function MobileExportMenu({
  onExport,
  isExporting,
}: {
  onExport: () => void
  isExporting: boolean
}) {
  return (
    <div className="sm:hidden">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button type="button" variant="outline" size="icon" aria-label="Thao tác khác" />}
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={onExport} disabled={isExporting} className="gap-2">
            {isExporting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <FileSpreadsheet className="size-4" />
            )}
            Xuất Excel
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
