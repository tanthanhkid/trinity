'use client'

/**
 * Mini-form "Tạo dự án mới" mở TỪ dropdown "Dự án" của popup Thêm sản phẩm
 * — để không phải rời màn đi tạo dự án ở nơi khác rồi quay lại.
 *
 * Gọi ĐÚNG `POST /projects` sẵn có (BE: `super_admin`/`operations` — cùng nhóm
 * được tạo sản phẩm, nên không nới quyền). Chỉ hỏi 2 trường tối thiểu (tên,
 * mã); loại dự án lấy mặc định của BE.
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import apiClient from '@/lib/api-client'
import type { ProjectOption } from '@/hooks/use-projects'

/** "Bán Lẻ" → "ban_le" (BE chỉ nhận `^[a-z0-9_]+$`, 2–100 ký tự). */
export function slugifyProjectCode(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100)
}

const CODE_RE = /^[a-z0-9_]+$/

function apiMessage(err: unknown): string {
  const msg = (err as { response?: { data?: { message?: unknown } } })?.response?.data?.message
  if (Array.isArray(msg)) return msg.join(', ')
  return typeof msg === 'string' ? msg : 'Tạo dự án thất bại. Vui lòng thử lại.'
}

type Props = {
  open: boolean
  onClose: () => void
  /** Gọi sau khi tạo xong — caller chọn luôn dự án mới ở dropdown. */
  onCreated: (project: ProjectOption) => void
}

export function ProjectQuickCreateDialog({ open, onClose, onCreated }: Props) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        {/* Nội dung chỉ mount khi dialog mở ⇒ state form tự reset mỗi lần mở. */}
        <QuickCreateBody onClose={onClose} onCreated={onCreated} />
      </DialogContent>
    </Dialog>
  )
}

function QuickCreateBody({ onClose, onCreated }: Omit<Props, 'open'>) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [codeTouched, setCodeTouched] = useState(false)
  const [error, setError] = useState('')

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiClient.post<ProjectOption>('/projects', {
        name: name.trim(),
        code: code.trim(),
      })
      return res.data
    },
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      onCreated(project)
    },
    onError: (err) => setError(apiMessage(err)),
  })

  function submit() {
    const trimmedName = name.trim()
    if (trimmedName.length < 2) return setError('Tên dự án tối thiểu 2 ký tự')
    if (code.length < 2 || !CODE_RE.test(code)) {
      return setError('Mã dự án tối thiểu 2 ký tự, chỉ gồm chữ thường, số và dấu gạch dưới')
    }
    setError('')
    mutation.mutate()
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Tạo dự án mới</DialogTitle>
      </DialogHeader>
      {/* Không dùng <form> lồng trong <form> của popup sản phẩm — Enter tự xử lý bằng onKeyDown. */}
      <div
        className="space-y-3"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          }
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="qp-name">Tên dự án *</Label>
          <Input
            id="qp-name"
            value={name}
            placeholder="VD: Bán lẻ"
            onChange={(e) => {
              setName(e.target.value)
              if (!codeTouched) setCode(slugifyProjectCode(e.target.value))
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="qp-code">Mã dự án *</Label>
          <Input
            id="qp-code"
            value={code}
            placeholder="ban_le"
            onChange={(e) => {
              setCodeTouched(true)
              setCode(e.target.value)
            }}
          />
          <p className="text-xs text-muted-foreground">
            Chữ thường, số, dấu gạch dưới. Không đổi được sau khi tạo.
          </p>
        </div>
        <p className="min-h-4 text-xs leading-4 text-destructive">{error}</p>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Huỷ
        </Button>
        <Button type="button" disabled={mutation.isPending} onClick={submit}>
          {mutation.isPending ? 'Đang tạo...' : 'Tạo dự án'}
        </Button>
      </DialogFooter>
    </>
  )
}
