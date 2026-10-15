"use client"

import * as React from "react"
import { Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/**
 * Dialog XÁC NHẬN dùng chung — thay các bản chép tay
 * `bg-red-600 text-white` / `bg-amber-600` / `window.confirm`.
 *
 * Bố cục cố định: nút Huỷ (`ghost`) BÊN TRÁI, nút xác nhận BÊN PHẢI (ngoài cùng).
 * `tone="destructive"` (mặc định) → nút xác nhận `variant="destructive"`;
 * `tone="default"` → `variant="default"` (xác nhận không phá huỷ).
 *
 * Component KHÔNG tự đóng sau khi bấm xác nhận: caller gọi `onOpenChange(false)`
 * khi mutation thành công (lỗi thì dialog giữ nguyên để thử lại). Khi `pending`
 * cả hai nút bị khoá và không đóng được bằng Esc/click ngoài.
 */
export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  /** Nội dung giải thích (chấp nhận JSX, vd tên đối tượng in đậm). */
  description?: React.ReactNode
  /** Nhãn nút xác nhận, động từ + đối tượng ("Xoá nhân viên"). Mặc định "Xoá" (destructive) / "Xác nhận" (default). */
  confirmLabel?: string
  /** Nhãn nút Huỷ. Mặc định "Huỷ". */
  cancelLabel?: string
  tone?: "destructive" | "default"
  /** Đang xử lý: khoá 2 nút + hiện spinner ở nút xác nhận. */
  pending?: boolean
  onConfirm: () => void | Promise<void>
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Huỷ",
  tone = "destructive",
  pending = false,
  onConfirm,
}: ConfirmDialogProps) {
  const destructive = tone === "destructive"
  const label = confirmLabel ?? (destructive ? "Xoá" : "Xác nhận")
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending && !next) return
        onOpenChange(next)
      }}
    >
      <DialogContent data-slot="confirm-dialog" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description != null && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            disabled={pending}
            onClick={() => void onConfirm()}
          >
            {pending && <Loader2 className="animate-spin" aria-hidden />}
            {label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
