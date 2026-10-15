'use client'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export interface OptionDialogState {
  mode: 'create' | 'edit'
  id?: number
  label: string
  value: string
  sort_order: number
}

export interface SettingsOptionDialogProps {
  state: OptionDialogState | null
  valueHint?: string
  saving: boolean
  onClose: () => void
  onChange: (
    update: (prev: OptionDialogState | null) => OptionDialogState | null,
  ) => void
  onSubmit: () => void
}

/**
 * Dialog thêm/sửa 1 option. Chỉ cho nhập mã nội bộ khi tạo mới
 * (không cho đổi mã sau đó để tránh FK orphan).
 */
export function SettingsOptionDialog({
  state,
  valueHint,
  saving,
  onClose,
  onChange,
  onSubmit,
}: SettingsOptionDialogProps) {
  return (
    <Dialog open={state !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {state?.mode === 'create' ? 'Thêm giá trị' : 'Sửa giá trị'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="opt-label">Nhãn hiển thị</Label>
            <Input
              id="opt-label"
              value={state?.label ?? ''}
              placeholder="Vd: Đã báo giá"
              onChange={(e) =>
                onChange((s) => (s ? { ...s, label: e.target.value } : s))
              }
            />
          </div>
          {state?.mode === 'create' && (
            <div className="space-y-2">
              <Label htmlFor="opt-value">
                Mã nội bộ{' '}
                <span className="text-xs text-muted-foreground">
                  (bỏ trống để tự sinh từ nhãn)
                </span>
              </Label>
              <Input
                id="opt-value"
                value={state.value}
                placeholder={valueHint ?? 'ma_gia_tri'}
                onChange={(e) =>
                  onChange((s) => (s ? { ...s, value: e.target.value } : s))
                }
                className="font-mono"
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="opt-sort">Thứ tự hiển thị</Label>
            <Input
              id="opt-sort"
              type="number"
              min={0}
              value={state?.sort_order ?? 0}
              onChange={(e) =>
                onChange((s) =>
                  s ? { ...s, sort_order: Number(e.target.value) || 0 } : s,
                )
              }
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button onClick={onSubmit} disabled={saving}>
            Lưu thay đổi
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
