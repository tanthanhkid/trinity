"use client"

import { useEffect } from "react"
import { Controller, useForm, type Resolver } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { FieldError } from "@/components/ui/field"
import { OptionSelect } from "./option-select"
import type { InboundSource, SimpleOption } from "./webhook-types"

const schema = z.object({
  name: z.string().trim().min(1, "Nhập tên nguồn").max(100, "Tối đa 100 ký tự"),
  default_assignee_id: z.string().min(1, "Chọn sale nhận khách"),
  contact_source_id: z.string().min(1, "Chọn nguồn khách"),
  signed: z.boolean(),
})
export type SourceFormValues = z.infer<typeof schema>

/** Tạo / sửa nguồn webhook vào. Người nhận lấy ĐÚNG nguồn BE ràng buộc (phạm vi contacts.transfer). */
export function WebhookSourceDialog({
  open,
  onOpenChange,
  source,
  assignees,
  sources,
  pending,
  error,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  source: InboundSource | null
  assignees: SimpleOption[]
  sources: SimpleOption[]
  pending: boolean
  error: string | null
  onSubmit: (v: SourceFormValues) => void
}) {
  const { register, control, handleSubmit, reset, formState: { errors } } = useForm<SourceFormValues>({
    resolver: zodResolver(schema) as Resolver<SourceFormValues>,
    defaultValues: { name: "", default_assignee_id: "", contact_source_id: "", signed: false },
  })
  useEffect(() => {
    if (!open) return
    reset(source
      ? { name: source.name, default_assignee_id: String(source.default_assignee_id), contact_source_id: String(source.contact_source_id), signed: source.signed }
      : { name: "", default_assignee_id: "", contact_source_id: "", signed: false })
  }, [open, source, reset])

  const toOptions = (list: SimpleOption[]) => list.map((o) => ({ value: String(o.id), label: o.label }))
  return (
    <Dialog open={open} onOpenChange={(o) => (pending ? undefined : onOpenChange(o))}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{source ? "Sửa nguồn webhook vào" : "Thêm nguồn webhook vào"}</DialogTitle>
            <DialogDescription>Nguồn ngoài (landing page, form, hệ thống khác) đẩy khách vào CRM qua một đường dẫn riêng.</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="src-name">Tên nguồn</Label>
            <Input id="src-name" placeholder="Landing page Facebook" className="max-sm:h-11" {...register("name")} />
            {errors.name && <FieldError>{errors.name.message}</FieldError>}
          </div>

          <div className="space-y-1.5">
            <Controller control={control} name="default_assignee_id" render={({ field }) => (
              <OptionSelect label="Sale nhận khách" value={field.value} options={toOptions(assignees)} onChange={field.onChange} placeholder="Chọn sale nhận khách" className="h-9 w-full max-sm:h-11" />
            )} />
            {errors.default_assignee_id && <FieldError>{errors.default_assignee_id.message}</FieldError>}
            <p className="text-xs text-muted-foreground">Khách tạo ra thuộc người này. Chỉ chọn được người trong phạm vi chuyển khách của bạn.</p>
          </div>

          <div className="space-y-1.5">
            <Controller control={control} name="contact_source_id" render={({ field }) => (
              <OptionSelect label="Nguồn khách" value={field.value} options={toOptions(sources)} onChange={field.onChange} placeholder="Chọn nguồn khách" className="h-9 w-full max-sm:h-11" />
            )} />
            {errors.contact_source_id && <FieldError>{errors.contact_source_id.message}</FieldError>}
          </div>

          <Controller control={control} name="signed" render={({ field }) => (
            <label className="flex items-start gap-2 text-sm max-sm:min-h-11">
              <Checkbox checked={field.value} onCheckedChange={field.onChange} className="mt-0.5" />
              <span>
                Bắt buộc chữ ký <code>X-Trinity-Signature</code>
                <span className="block text-xs text-muted-foreground">Khuyến nghị: token nằm trong đường dẫn nên có thể lọt vào log của bên trung gian. {source?.signed && !field.value ? "Bỏ chọn sẽ tắt yêu cầu chữ ký." : ""}</span>
              </span>
            </label>
          )} />

          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending} className="max-sm:h-11">Huỷ</Button>
            <Button type="submit" disabled={pending} className="max-sm:h-11">
              {pending && <Loader2 className="mr-1 size-4 animate-spin" />}
              {source ? "Lưu thay đổi" : "Tạo nguồn"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
