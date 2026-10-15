"use client"

import { useState } from "react"
import { Check, Copy, ShieldAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

export interface RevealItem {
  label: string
  value: string
  /** true ⇒ hiện trong khung nhiều dòng (curl). */
  multiline?: boolean
}

/** Sao chép có phản hồi; clipboard bị chặn thì báo để người dùng tự chọn-copy. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle")
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setState("ok")
    } catch {
      setState("fail")
    }
    setTimeout(() => setState("idle"), 2500)
  }
  return (
    <Button type="button" variant="outline" size="sm" className="shrink-0 max-sm:h-11" onClick={copy} aria-label={`Sao chép ${label}`}>
      {state === "ok" ? <Check className="mr-1 size-4" /> : <Copy className="mr-1 size-4" />}
      {state === "ok" ? "Đã chép" : state === "fail" ? "Chọn và chép tay" : "Sao chép"}
    </Button>
  )
}

/**
 * Hiện bí mật MỘT lần (secret webhook ra / URL+token webhook vào / signing secret). Đóng dialog là mất — nên
 * KHÔNG đóng bằng click ra ngoài; chỉ nút "Đã lưu, đóng" (nút chính duy nhất).
 */
export function SecretRevealDialog({
  open,
  onClose,
  title,
  description,
  items,
}: {
  open: boolean
  onClose: () => void
  title: string
  description: string
  items: RevealItem[]
}) {
  return (
    <Dialog open={open} onOpenChange={() => undefined /* chỉ đóng bằng nút */}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span>Giá trị dưới đây <strong>chỉ hiện một lần</strong>. Hãy sao chép và lưu vào nơi an toàn trước khi đóng.</span>
        </div>
        <div className="space-y-3">
          {items.map((it) => (
            <div key={it.label} className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-muted-foreground">{it.label}</span>
                <CopyButton value={it.value} label={it.label} />
              </div>
              {it.multiline ? (
                <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap break-all">{it.value}</pre>
              ) : (
                <code className="block rounded-md bg-muted p-2 text-xs break-all select-all">{it.value}</code>
              )}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button type="button" onClick={onClose} className="max-sm:h-11">Đã lưu, đóng</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
