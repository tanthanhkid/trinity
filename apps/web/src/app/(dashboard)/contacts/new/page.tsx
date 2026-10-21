"use client"

import { Suspense, useEffect, useMemo, useRef } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useForm, type Resolver } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"
import { Loader2, ArrowLeft, Save } from "lucide-react"
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { FieldError } from "@/components/ui/field"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import Link from "next/link"
import apiClient from "@/lib/api-client"
import { useSettingsOptions } from "@/hooks/use-settings-options"
import { useAuth } from "@/hooks/use-auth"
import { Forbidden, usePermissions } from "@/lib/rbac"
import { MobileActionBar } from "@/components/app-shell/mobile-action-bar"
import { DealAssigneePicker } from "./_components/deal-assignee-picker"
import { VnDateInput } from "@/components/ui/vn-date-input"
import { VnDateTimeInput } from "@/components/ui/vn-datetime-input"
import { errorMessage } from "@/lib/error-messages"

/**
 * Form tạo contact mới.
 *  - BẮT BUỘC: phone, source_id.
 *  - TUỲ CHỌN: họ tên, ngày sinh, giới tính, địa chỉ, công ty...
 *  - Lock sau khi tạo: phone, full_name, source_id.
 */

const baseSchema = z.object({
  phone: z
    .string()
    .min(1, "Vui lòng nhập số điện thoại")
    .regex(/^(0|\+84)\d{9}$/, "SĐT phải bắt đầu bằng 0 hoặc +84 và có 10 chữ số"),
  phone_2: z
    .string()
    .regex(/^(0|\+84)\d{9}$/, "SĐT 2 không hợp lệ. VD: 0900000003")
    .optional()
    .or(z.literal("")),
  full_name: z.string().optional(),
  source_id: z
    .number()
    .int()
    .positive("Vui lòng chọn nguồn"),
  stage_id: z.number().int().positive().optional(),
  contact_status_id: z.number().int().positive().optional(),
  birthday: z.string().optional(),
  gender: z.string().optional(),
  current_address: z.string().optional(),
  company_name: z.string().optional(),
  job_title: z.string().optional(),
  email: z
    .string()
    .email("Email không hợp lệ")
    .optional()
    .or(z.literal("")),
  reminder_at: z.string().optional(),
  reminder_notes: z.string().optional(),
  deal_assigned_to: z.number().int().positive().optional(),
})

const schema = baseSchema

type FormData = z.infer<typeof schema>

interface CreateContactResponse {
  contact: { id: string }
  warning: string | null
}

const GENDERS = [
  { value: "nam", label: "Nam" },
  { value: "nu", label: "Nữ" },
]

function NewContactForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  // Dữ liệu điền sẵn từ query string (SĐT, tên).
  const prefilledPhone = searchParams.get("phone") ?? ""
  const prefilledName = searchParams.get("full_name") ?? ""
  // Nguồn bị khoá khi truyền ?source=<value>. Khớp theo
  // setting_options.value (bền vững nếu admin đổi nhãn).
  const lockedSourceValue = searchParams.get("source") ?? ""
  const { isLoading: authLoading } = useAuth()
  const { can } = usePermissions()
  // Quyền tạo = `contacts.create` (BE `POST /contacts`); thiếu → `<Forbidden />`
  // ở dưới thay vì cho điền form rồi 403.
  const allowed = can("contacts.create")

  const { data: sources = [] } = useSettingsOptions("contact_source")
  const { data: stages = [] } = useSettingsOptions("contact_stage")
  const { data: statuses = [] } = useSettingsOptions("contact_detail_status")
  // Gán thương vụ cho sale = `deals.manage` (BE kiểm phạm vi từng người được gán).
  const canAssignDeal = can("deals.manage")

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema) as Resolver<FormData>,
    defaultValues: {
      phone: prefilledPhone,
      full_name: prefilledName,
    },
  })

  const sourceId = watch("source_id")
  const stageId = watch("stage_id")
  const contactStatusId = watch("contact_status_id")
  const gender = watch("gender")
  const dealAssignedTo = watch("deal_assigned_to")
  const birthday = watch("birthday")

  // Nguồn khoá: tìm option theo value (vd "facebook"). null khi không truyền
  // param hoặc option chưa tồn tại trên môi trường → fallback dropdown tự chọn.
  const lockedSource = useMemo(
    () => (lockedSourceValue ? sources.find((o) => o.value === lockedSourceValue) ?? null : null),
    [lockedSourceValue, sources],
  )
  // Gán source_id 1 lần khi options đã tải (ref-guard chống render-storm — sources
  // load async nên không đặt được vào defaultValues).
  const lockedSourceAppliedRef = useRef(false)
  useEffect(() => {
    if (!lockedSource || lockedSourceAppliedRef.current) return
    lockedSourceAppliedRef.current = true
    setValue("source_id", lockedSource.id, { shouldValidate: true })
  }, [lockedSource, setValue])

  const mutation = useMutation<CreateContactResponse, Error, FormData>({
    mutationFn: async (data) => {
      const payload = {
        ...data,
        email: data.email || undefined,
        phone_2: data.phone_2 || undefined,
        reminder_at: data.reminder_at ? new Date(data.reminder_at).toISOString() : undefined,
      }
      if (!canAssignDeal) delete payload.deal_assigned_to
      const res = await apiClient.post<CreateContactResponse>(
        "/contacts",
        payload,
      )
      return res.data
    },
    onSuccess: (response) => {
      if (response.warning) {
        toast.warning(response.warning)
      } else {
        toast.success("Đã tạo khách hàng thành công")
      }
      router.push(`/contacts/${response.contact.id}`)
    },
    onError: (err) => {
      toast.error(errorMessage(err, "Chưa tạo được khách hàng"))
    },
  })

  if (authLoading) {
    return <div className="py-24 text-center text-muted-foreground">Đang tải...</div>
  }
  if (!allowed) return <Forbidden message="Cần quyền Thêm khách hàng." />

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <Link
        href="/contacts"
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground w-fit max-sm:min-h-11"
      >
        <ArrowLeft className="h-4 w-4" /> Quay lại khách hàng
      </Link>
      <h1 className="text-3xl font-bold max-sm:text-2xl">Thêm khách hàng mới</h1>
      {/* 2 cột (form chính + rail hướng dẫn) — Rail xếp XUỐNG DƯỚI form trên màn hẹp. */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)] lg:items-start">
      <form
        onSubmit={handleSubmit((data) => mutation.mutate(data))}
        className="space-y-4"
      >
        <Card className="shadow-[0_4px_16px_rgba(0,0,0,0.06)] rounded-2xl">
          <CardHeader>
            <CardTitle>Thông tin bắt buộc</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="phone">
                Số điện thoại <span className="text-destructive" aria-hidden>*</span>
              </Label>
              <Input
                id="phone"
                placeholder="0900000001"
                inputMode="tel"
                pattern="[0-9+]*"
                {...register("phone")}
              />
              {errors.phone && (
                <FieldError>{errors.phone.message}</FieldError>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="phone_2">Số điện thoại 2 (dự phòng)</Label>
              <Input
                id="phone_2"
                placeholder="0900000003 (tuỳ chọn)"
                inputMode="tel"
                pattern="[0-9+]*"
                {...register("phone_2")}
              />
              {errors.phone_2 && (
                <FieldError>{errors.phone_2.message}</FieldError>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="full_name">Họ và tên</Label>
              <Input
                id="full_name"
                placeholder="Nhập họ và tên"
                {...register("full_name")}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>
                Nguồn (Thủ công) <span className="text-destructive" aria-hidden>*</span>
              </Label>
              {lockedSource ? (
                <>
                  <Input value={lockedSource.label} disabled readOnly className="bg-muted" />
                  <p className="text-xs text-muted-foreground">
                    Nguồn được gán sẵn.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    Vào Cài đặt → Nguồn khách để chỉnh sửa giá trị (Facebook, Zalo,…).
                  </p>
                  <Select
                    value={sourceId ? String(sourceId) : ""}
                    onValueChange={(v) =>
                      setValue("source_id", v ? Number(v) : 0, {
                        shouldValidate: true,
                      })
                    }
                    items={sources.map((o) => ({ value: String(o.id), label: o.label }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Chọn nguồn">
                        {(v) => {
                          if (typeof v !== "string" || !v) return null
                          return sources.find((o) => String(o.id) === v)?.label ?? null
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {sources.map((o) => (
                        <SelectItem key={o.id} value={String(o.id)}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              )}
              {errors.source_id && (
                <FieldError>
                  {errors.source_id.message}
                </FieldError>
              )}
            </div>
            {canAssignDeal && (
              <div className="flex flex-col gap-1.5">
                <Label>Gán thương vụ cho sale phụ trách</Label>
                <DealAssigneePicker
                  value={dealAssignedTo}
                  invalid={!!errors.deal_assigned_to}
                  onChange={(next) => {
                    setValue("deal_assigned_to", next, { shouldValidate: true })
                  }}
                />
                {errors.deal_assigned_to && (
                  <FieldError>{errors.deal_assigned_to.message}</FieldError>
                )}
                <p className="text-xs text-muted-foreground">
                  Chọn sale để tự tạo thương vụ và chia sẻ khách hàng với sale được gán.
                </p>
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label>Giai đoạn</Label>
                <Select
                  value={stageId ? String(stageId) : ""}
                  onValueChange={(v) =>
                    setValue(
                      "stage_id",
                      v ? Number(v) : undefined,
                    )
                  }
                  items={stages.map((o) => ({ value: String(o.id), label: o.label }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Mặc định: Mới">
                      {(v) => {
                        if (typeof v !== "string" || !v) return null
                        return stages.find((o) => String(o.id) === v)?.label ?? null
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {stages.map((o) => (
                      <SelectItem key={o.id} value={String(o.id)}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Trạng thái chi tiết</Label>
                <Select
                  value={contactStatusId ? String(contactStatusId) : ""}
                  onValueChange={(v) =>
                    setValue(
                      "contact_status_id",
                      v ? Number(v) : undefined,
                    )
                  }
                  items={statuses.map((o) => ({ value: String(o.id), label: o.label }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Chưa chọn">
                      {(v) => {
                        if (typeof v !== "string" || !v) return null
                        return statuses.find((o) => String(o.id) === v)?.label ?? null
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {statuses.map((o) => (
                      <SelectItem key={o.id} value={String(o.id)}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        <Accordion multiple className="w-full">
          <AccordionItem value="personal">
            <AccordionTrigger className="rounded-lg px-4 max-sm:min-h-11">
              Thông tin cá nhân
            </AccordionTrigger>
            <AccordionContent className="px-4 pt-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="birthday">Ngày sinh</Label>
                  <VnDateInput
                    id="birthday"
                    value={birthday ?? ""}
                    onChange={(iso) => setValue("birthday", iso || undefined)}
                    placeholder="DD/MM/YYYY"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Giới tính</Label>
                  <Select
                    value={gender ?? ""}
                    onValueChange={(v) => setValue("gender", v ?? undefined)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Chọn giới tính">
                        {(v) => {
                          if (typeof v !== "string" || !v) return null
                          return GENDERS.find((g) => g.value === v)?.label ?? null
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {GENDERS.map((g) => (
                        <SelectItem key={g.value} value={g.value}>
                          {g.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label htmlFor="current_address">Địa chỉ hiện tại</Label>
                  <Input
                    id="current_address"
                    placeholder="123 Example Street, District 1"
                    {...register("current_address")}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="ten@example.com"
                    {...register("email")}
                  />
                  {errors.email && (
                    <FieldError>{errors.email.message}</FieldError>
                  )}
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="work">
            <AccordionTrigger className="rounded-lg px-4 max-sm:min-h-11">
              Thông tin công việc
            </AccordionTrigger>
            <AccordionContent className="px-4 pt-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="company_name">Công ty</Label>
                  <Input
                    id="company_name"
                    placeholder="Công ty ABC"
                    {...register("company_name")}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="job_title">Chức danh</Label>
                  <Input
                    id="job_title"
                    placeholder="Nhân viên văn phòng"
                    {...register("job_title")}
                  />
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="reminder">
            <AccordionTrigger className="rounded-lg px-4 max-sm:min-h-11">
              Nhắc việc
            </AccordionTrigger>
            <AccordionContent className="px-4 pt-2 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="reminder_at">Lịch hẹn nhắc</Label>
                  <VnDateTimeInput
                    id="reminder_at"
                    value={watch("reminder_at")}
                    onChange={(v) => setValue("reminder_at", v, { shouldDirty: true })}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reminder_notes">Ghi chú nhắc</Label>
                <Textarea
                  id="reminder_notes"
                  placeholder="Gửi báo giá sáng mai..."
                  rows={3}
                  {...register("reminder_notes")}
                />
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>

        <MobileActionBar className="sm:gap-3 sm:pt-2">
          <Button
            type="button"
            variant="ghost"
            className="h-11"
            onClick={() => router.back()}
            disabled={mutation.isPending}
          >
            Huỷ
          </Button>
          <Button
            type="submit"
            className="h-11"
            disabled={mutation.isPending}
          >
            {mutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Lưu khách hàng
          </Button>
        </MobileActionBar>
      </form>

      {/* Rail phải — hướng dẫn tĩnh, KHÔNG có logic/state riêng nên không rủi ro
          với luồng submit của form bên trái. */}
      <aside className="space-y-4 lg:sticky lg:top-4">
        <Card className="shadow-[0_4px_16px_rgba(0,0,0,0.06)] rounded-2xl bg-[var(--color-app-primary-soft)] border-none">
          <CardContent className="space-y-2 pt-6 text-sm text-[var(--color-app-primary-ink)]">
            <p className="font-semibold">Trước khi lưu</p>
            <ul className="list-disc space-y-1 pl-4">
              <li>Số điện thoại là bắt buộc và không sửa được sau khi tạo.</li>
              <li>Điền càng đủ thông tin, Sale chăm sóc càng chính xác.</li>
              <li>Khách hàng trùng SĐT với người khác sẽ bị từ chối lưu.</li>
            </ul>
          </CardContent>
        </Card>
      </aside>
      </div>
    </div>
  )
}

// useSearchParams() bắt buộc bọc trong <Suspense> (Next.js 16 — tránh prerender error).
export default function NewContactPage() {
  return (
    <Suspense
      fallback={
        <div className="py-24 text-center text-muted-foreground">Đang tải...</div>
      }
    >
      <NewContactForm />
    </Suspense>
  )
}
