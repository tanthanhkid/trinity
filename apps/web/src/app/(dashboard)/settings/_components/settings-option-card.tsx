'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { ShellListCard } from '@/components/app-shell/list-card'
import { Lock, MoreHorizontal, Trash2 } from 'lucide-react'
import { SettingOption } from '@/hooks/use-settings-options'
import { OptionDialogState } from './settings-option-dialog'

export interface SettingsOptionCardProps {
  option: SettingOption
  renderExtra?: (option: SettingOption) => React.ReactNode
  onEdit: (state: OptionDialogState) => void
  onToggleActive: (option: SettingOption) => void
  onDelete: (option: SettingOption) => void
}

/**
 * Thẻ 1 giá trị danh mục trên ĐIỆN THOẠI — thay bảng 7 cột cuộn
 * ngang. Chỉ render trong nhánh `sm:hidden` của `ShellResponsiveList`.
 */
export function SettingsOptionCard({
  option,
  renderExtra,
  onEdit,
  onToggleActive,
  onDelete,
}: SettingsOptionCardProps) {
  return (
    <ShellListCard className="space-y-2">
      <div className="flex items-start gap-2">
        <button
          type="button"
          className="min-h-11 min-w-0 flex-1 text-left"
          onClick={() =>
            onEdit({
              mode: 'edit',
              id: option.id,
              label: option.label,
              value: option.value,
              sort_order: option.sort_order,
            })
          }
        >
          <span className="block break-words font-medium">{option.label}</span>
          <span className="block break-all font-mono text-xs text-muted-foreground">
            {option.value}
          </span>
        </button>
        {!option.is_system && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon" aria-label="Thao tác khác" />
              }
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                variant="destructive"
                className="gap-2"
                onClick={() => onDelete(option)}
              >
                <Trash2 className="size-4" />
                Ẩn giá trị
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {renderExtra?.(option)}
      <div className="flex min-h-11 items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {option.is_system ? (
            <Badge variant="outline" className="gap-1">
              <Lock className="size-3" /> Hệ thống
            </Badge>
          ) : (
            <Badge variant="outline">Tuỳ chỉnh</Badge>
          )}
          <span className="text-xs text-muted-foreground">
            Thứ tự {option.sort_order}
          </span>
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          Đang bật
          <Switch
            checked={option.is_active}
            onCheckedChange={() => onToggleActive(option)}
            aria-label="Đang bật"
          />
        </label>
      </div>
      {option.is_system && (
        <p className="text-xs text-muted-foreground">
          Giá trị hệ thống — không xoá được
        </p>
      )}
    </ShellListCard>
  )
}
