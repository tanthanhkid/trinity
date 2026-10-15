'use client'

import { useCallback } from 'react'
import { toast } from 'sonner'
import {
  SettingOption,
  slugifyValue,
  useCreateSettingOption,
  useDeleteSettingOption,
  useUpdateSettingOption,
} from '@/hooks/use-settings-options'
import { OptionDialogState } from './settings-option-dialog'

interface UseOptionsHandlersArgs {
  group: string
  dialog: OptionDialogState | null
  onClose: () => void
}

/**
 * Handlers cho SettingsOptionsTable — tách khỏi component chính để file
 * component < 200 dòng. Mỗi handler ≤ 30 dòng.
 */
export function useOptionsHandlers({
  group,
  dialog,
  onClose,
}: UseOptionsHandlersArgs) {
  const createM = useCreateSettingOption(group)
  const updateM = useUpdateSettingOption(group)
  const deleteM = useDeleteSettingOption(group)

  const handleSubmit = useCallback(async () => {
    if (!dialog) return
    const label = dialog.label.trim()
    if (!label) {
      toast.error('Vui lòng nhập nhãn hiển thị')
      return
    }
    try {
      if (dialog.mode === 'create') {
        const value = (dialog.value.trim() || slugifyValue(label)).toLowerCase()
        if (!/^[a-z0-9_]{1,64}$/.test(value)) {
          toast.error('Mã chỉ chứa a-z, 0-9, _ (tối đa 64 ký tự)')
          return
        }
        await createM.mutateAsync({
          group_key: group,
          value,
          label,
          sort_order: dialog.sort_order,
        })
        toast.success('Đã thêm giá trị mới')
      } else if (dialog.id) {
        await updateM.mutateAsync({
          id: dialog.id,
          payload: { label, sort_order: dialog.sort_order },
        })
        toast.success('Đã cập nhật')
      }
      onClose()
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data
          ?.message ?? 'Không lưu được'
      toast.error(Array.isArray(msg) ? msg.join(', ') : String(msg))
    }
  }, [dialog, group, createM, updateM, onClose])

  const toggleActive = useCallback(
    async (opt: SettingOption) => {
      try {
        await updateM.mutateAsync({
          id: opt.id,
          payload: { is_active: !opt.is_active },
        })
        toast.success(opt.is_active ? 'Đã tắt' : 'Đã bật')
      } catch {
        toast.error('Không cập nhật được')
      }
    },
    [updateM],
  )

  const handleDelete = useCallback(
    async (opt: SettingOption) => {
      if (opt.is_system) {
        toast.error('Không xoá được giá trị hệ thống')
        return
      }
      try {
        await deleteM.mutateAsync(opt.id)
        toast.success('Đã ẩn giá trị')
      } catch {
        toast.error('Không xoá được')
      }
    },
    [deleteM],
  )

  return {
    handleSubmit,
    toggleActive,
    handleDelete,
    saving: createM.isPending || updateM.isPending,
  }
}
