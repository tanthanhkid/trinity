'use client'

import { type UseFormReturn } from 'react-hook-form'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DialogFooter } from '@/components/ui/dialog'
import { Loader2 } from 'lucide-react'
import { type ProjectForm, COLOR_OPTIONS } from './project-types'

// ---------------------------------------------------------------------------
// ColorSelect — controlled, prevents stale color when dialog reopens
// ---------------------------------------------------------------------------

export function ColorSelect({
  value,
  onValueChange,
}: {
  value?: string
  onValueChange: (val: string | null) => void
}) {
  return (
    <Select value={value ?? ''} onValueChange={onValueChange}>
      <SelectTrigger className="h-11">
        <SelectValue placeholder="Chọn màu sắc...">
          {(v) => {
            if (typeof v !== 'string' || !v) return null
            const c = COLOR_OPTIONS.find((x) => x.value === v)
            if (!c) return null
            return (
              <span className="flex items-center gap-2">
                <span className={`inline-block w-3 h-3 rounded-full ${c.class}`} />
                {c.label}
              </span>
            )
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {COLOR_OPTIONS.map((c) => (
          <SelectItem key={c.value} value={c.value}>
            <span className="flex items-center gap-2">
              <span className={`inline-block w-3 h-3 rounded-full ${c.class}`} />
              {c.label}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ---------------------------------------------------------------------------
// ProjectFormFields — form fields + footer (used inside ProjectFormDialog)
// ---------------------------------------------------------------------------

interface ProjectFormFieldsProps {
  form: UseFormReturn<ProjectForm>
  isEdit: boolean
  isPending: boolean
  isError: boolean
  onClose: () => void
}

export function ProjectFormFields({
  form,
  isEdit,
  isPending,
  isError,
  onClose,
}: ProjectFormFieldsProps) {
  const { register, setValue, watch, formState: { errors } } = form
  const watchColor = watch('color')

  return (
    <>
      <div className="flex-1 min-h-0 space-y-4 overflow-y-auto px-1">
        <div className="space-y-1">
          <Label>Tên dự án</Label>
          <Input {...register('name')} placeholder="Nhập tên dự án..." className="h-11" />
          {errors.name && <p className="text-xs text-red-500">{errors.name.message}</p>}
        </div>
        {!isEdit && (
          <div className="space-y-1">
            <Label>Mã dự án</Label>
            <Input {...register('code')} placeholder="vd: ban_le" className="h-11" />
            <p className="text-xs text-muted-foreground">Chỉ dùng chữ thường, số và gạch dưới</p>
            {errors.code && <p className="text-xs text-red-500">{errors.code.message}</p>}
          </div>
        )}
        <div className="space-y-1">
          <Label>Màu sắc</Label>
          <ColorSelect
            value={watchColor}
            onValueChange={(val) => setValue('color', val ?? undefined, { shouldValidate: true })}
          />
        </div>
        {isError && <p className="text-xs text-red-500">Có lỗi xảy ra. Vui lòng thử lại.</p>}
      </div>
      <DialogFooter className="shrink-0 pt-4">
        <Button variant="ghost" onClick={onClose} type="button" disabled={isPending}>
          Huỷ
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? (
            <><Loader2 className="h-4 w-4 mr-1 animate-spin" />{isEdit ? 'Đang lưu...' : 'Đang tạo...'}</>
          ) : (isEdit ? 'Lưu thay đổi' : 'Tạo dự án')}
        </Button>
      </DialogFooter>
    </>
  )
}
