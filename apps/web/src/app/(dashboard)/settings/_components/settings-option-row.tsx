'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { TableCell, TableRow } from '@/components/ui/table'
import { Lock, Trash2 } from 'lucide-react'
import { SettingOption } from '@/hooks/use-settings-options'
import { OptionDialogState } from './settings-option-dialog'

export interface SettingsOptionRowProps {
  option: SettingOption
  renderExtraCells?: (option: SettingOption) => React.ReactNode
  onEdit: (state: OptionDialogState) => void
  onToggleActive: (option: SettingOption) => void
  onDelete: (option: SettingOption) => void
}

/** Row đơn — tách khỏi settings-options-table để file ≤200 dòng. */
export function SettingsOptionRow({
  option,
  renderExtraCells,
  onEdit,
  onToggleActive,
  onDelete,
}: SettingsOptionRowProps) {
  return (
    <TableRow>
      <TableCell>
        <button
          className="text-left font-medium hover:underline"
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
          {option.label}
        </button>
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">
        {option.value}
      </TableCell>
      <TableCell>{option.sort_order}</TableCell>
      {renderExtraCells?.(option)}
      <TableCell>
        <Checkbox
          checked={option.is_active}
          onCheckedChange={() => onToggleActive(option)}
          aria-label="Đang bật"
        />
      </TableCell>
      <TableCell>
        {option.is_system ? (
          <Badge variant="outline" className="gap-1">
            <Lock className="size-3" /> Hệ thống
          </Badge>
        ) : (
          <Badge variant="outline">Tuỳ chỉnh</Badge>
        )}
      </TableCell>
      <TableCell className="text-right">
        <Button
          variant="ghost"
          size="sm"
          disabled={option.is_system}
          title={
            option.is_system
              ? 'Giá trị hệ thống — không xoá được'
              : 'Xoá mềm'
          }
          onClick={() => onDelete(option)}
        >
          <Trash2 className="size-4" />
        </Button>
      </TableCell>
    </TableRow>
  )
}
