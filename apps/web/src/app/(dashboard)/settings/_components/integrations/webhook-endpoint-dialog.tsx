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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { groupEvents, type WebhookEndpoint, type WebhookEventDef } from "./webhook-types"

const schema = z.object({
  name: z.string().trim().min(1, "Nhập tên endpoint").max(100, "Tối đa 100 ký tự"),
  url: z
    .string()
    .trim()
    .min(1, "Nhập địa chỉ nhận")
    .max(2048, "Địa chỉ quá dài")
    .refine((v) => /^https:\/\//i.test(v), "Địa chỉ phải bắt đầu bằng https://"),
  events: z.array(z.string()).min(1, "Chọn ít nhất 1 sự kiện"),
})
export type EndpointFormValues = z.infer<typeof schema>

/** Tạo / sửa endpoint webhook ra. Lỗi BE (URL bị chặn SSRF, quá 20 endpoint...) hiện nguyên văn ở `error`. */
export function WebhookEndpointDialog({
  open,
  onOpenChange,
  endpoint,
  events,
  pending,
  error,
  canSeePhone,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  endpoint: WebhookEndpoint | null
  events: WebhookEventDef[]
  pending: boolean
  error: string | null
  canSeePhone: boolean
  onSubmit: (v: EndpointFormValues) => void
}) {
  const form = useForm<EndpointFormValues>({
    resolver: zodResolver(schema) as Resolver<EndpointFormValues>,
    defaultValues: { name: "", url: "", events: [] },
  })
  const { register, control, handleSubmit, reset, formState: { errors } } = form

  useEffect(() => {
    if (open) reset(endpoint ? { name: endpoint.name, url: endpoint.url, events: endpoint.events } : { name: "", url: "", events: [] })
  }, [open, endpoint, reset])

  const groups = groupEvents(events)
  return (
    <Dialog open={open} onOpenChange={(o) => (pending ? undefined : onOpenChange(o))}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{endpoint ? "Sửa endpoint webhook" : "Thêm endpoint webhook"}</DialogTitle>
            <DialogDescription>Trinity gửi sự kiện tới địa chỉ này kèm chữ ký để bên nhận kiểm tra.</DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <Field invalid={!!errors.name}>
              <FieldLabel htmlFor="wh-name">Tên</FieldLabel>
              <Input id="wh-name" placeholder="Zapier — khách mới" aria-invalid={!!errors.name || undefined} {...register("name")} />
              <FieldError>{errors.name?.message}</FieldError>
            </Field>

            <Field invalid={!!errors.url}>
              <FieldLabel htmlFor="wh-url">Địa chỉ nhận (HTTPS)</FieldLabel>
              <Input id="wh-url" inputMode="url" placeholder="https://hooks.example.com/trinity" aria-invalid={!!errors.url || undefined} {...register("url")} />
              {errors.url ? <FieldError>{errors.url.message}</FieldError> : <FieldDescription>Chỉ nhận địa chỉ https:// công khai, cổng 443/8443. Địa chỉ nội bộ bị chặn.</FieldDescription>}
            </Field>

            <Field invalid={!!errors.events}>
              <span className="text-[13px] leading-4 font-medium text-foreground/90 group-data-[invalid=true]/field:text-destructive">Sự kiện</span>
              <Controller
                control={control}
                name="events"
                render={({ field }) => (
                  <div className="flex flex-col gap-3">
                    {groups.map((g) => {
                      const all = g.items.every((i) => field.value.includes(i.type))
                      const toggleGroup = (checked: boolean) => {
                        const rest = field.value.filter((v) => !g.items.some((i) => i.type === v))
                        field.onChange(checked ? [...rest, ...g.items.map((i) => i.type)] : rest)
                      }
                      return (
                        <fieldset key={g.resource} className="overflow-hidden rounded-[10px] border border-border bg-card">
                          {/* Thẻ nhóm: tiêu đề bên trái, "Chọn tất cả" bên phải; mỗi sự kiện một dòng, mã kỹ thuật xuống dòng phụ. */}
                          <legend className="sr-only">{g.label}</legend>
                          <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/40 px-3 py-2">
                            <span className="text-sm font-medium">{g.label}</span>
                            <label className="flex min-h-6 items-center gap-2 text-[13px] text-muted-foreground max-sm:min-h-11">
                              Chọn tất cả
                              <Checkbox checked={all} onCheckedChange={toggleGroup} aria-label={`Chọn cả nhóm ${g.label}`} />
                            </label>
                          </div>
                          <div className="divide-y divide-border">
                            {g.items.map((i) => {
                              const on = field.value.includes(i.type)
                              return (
                                <label
                                  key={i.type}
                                  className={`flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 transition-colors duration-150 ${on ? "bg-primary/5" : "hover:bg-muted/50"}`}
                                >
                                  <Checkbox
                                    checked={on}
                                    onCheckedChange={(c) => field.onChange(c ? [...field.value, i.type] : field.value.filter((v) => v !== i.type))}
                                  />
                                  <span className="flex min-w-0 flex-col">
                                    <span className="text-sm">{i.label}</span>
                                    <code className="font-mono text-xs text-muted-foreground">{i.type}</code>
                                  </span>
                                </label>
                              )
                            })}
                          </div>
                        </fieldset>
                      )
                    })}
                  </div>
                )}
              />
              <FieldError>{errors.events?.message}</FieldError>
            </Field>
          </FieldGroup>

          <p className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
            Dữ liệu gửi đi theo <strong>quyền của người tạo (hoặc người đổi địa chỉ nhận gần nhất)</strong>: chỉ gồm khách/deal/đơn người đó xem được.{" "}
            {canSeePhone
              ? "Bạn có quyền xem SĐT đầy đủ nên SĐT khách trong phạm vi của bạn được gửi đầy đủ."
              : "Bạn không có quyền xem SĐT đầy đủ nên SĐT sẽ bị che dạng ***123."}{" "}
            Nếu người tạo bị khoá hoặc mất quyền, endpoint tự tắt.
          </p>

          {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>Huỷ</Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="mr-1 size-4 animate-spin" />}
              {endpoint ? "Lưu thay đổi" : "Tạo endpoint"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
