"use client"

import { useEffect } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { AxField } from "@/components/ui/field"
import { HeroCard } from "@/components/ui/hero-card"
import { AX_INPUT_CLASS } from "@/components/ui/input"
import { StickyActionBar } from "@/components/ui/sticky-action-bar"
import { cn } from "@/lib/utils"
import { autoMaskVnDate, parseVnDate, todayVn } from "@/lib/format"
import {
  REQUEST_TYPE_LABEL,
  useAttendanceRequests,
  useCreateRequest,
  useRequestConfig,
  type AttendanceRequestType,
} from "@/hooks/use-attendance"
import { errorMessage } from "@/lib/error-messages"
import { quotaFor, quotaGroupOf, QUOTA_GROUP_LABEL } from "./attendance-board-utils"

const REQUEST_TYPES = Object.entries(REQUEST_TYPE_LABEL) as [
  AttendanceRequestType,
  string,
][]

// Loại có trường check_in_time
const NEEDS_CHECK_IN: AttendanceRequestType[] = ["forgot_check_in"]
// Loại có trường check_out_time
const NEEDS_CHECK_OUT: AttendanceRequestType[] = ["forgot_check_out"]

const REQUEST_TYPE_KEYS = Object.keys(REQUEST_TYPE_LABEL) as [
  AttendanceRequestType,
  ...AttendanceRequestType[],
]

// Loại đơn cho phép chọn ngày TƯƠNG LAI (xin nghỉ trước): nghỉ phép và nghỉ thai sản.
// Các loại còn lại (quên chấm/đến muộn/về sớm) chỉ ghi nhận cho ngày đã qua/hôm nay.
const FUTURE_DATE_ALLOWED_TYPES: AttendanceRequestType[] = ["leave", "maternity"]

const schema = z
  .object({
    work_date_display: z
      .string()
      .min(1, "Vui lòng nhập ngày")
      .refine((v) => {
        const iso = parseVnDate(v)
        return !!iso
      }, "Ngày không hợp lệ (DD/MM/YYYY)"),
    type: z.enum(REQUEST_TYPE_KEYS, { error: "Vui lòng chọn loại đơn" }),
    check_in_time: z.string().optional(),
    check_out_time: z.string().optional(),
    reason: z.string().min(1, "Vui lòng nhập lý do").max(500, "Tối đa 500 ký tự"),
  })
  .refine(
    (d) => {
      const iso = parseVnDate(d.work_date_display)
      if (!iso) return false
      // "Nghỉ phép"/"Nghỉ thai sản" xin trước → cho phép ngày tương lai. Các
      // loại khác giữ nguyên ràng buộc phải TRƯỚC hôm nay.
      if (FUTURE_DATE_ALLOWED_TYPES.includes(d.type)) return true
      return iso < todayVn()
    },
    {
      message: "Ngày làm phải là ngày trong quá khứ (trước hôm nay)",
      path: ["work_date_display"],
    },
  )
  // Quên check-in → bắt buộc giờ vào (khớp BE: createRequest yêu cầu requested_check_in).
  // Thiếu refine này → form gửi rỗng → BE trả 400 → toast "Gửi đơn thất bại".
  .refine((d) => d.type !== "forgot_check_in" || !!d.check_in_time?.trim(), {
    message: "Vui lòng nhập giờ vào xin bổ sung",
    path: ["check_in_time"],
  })
  // Quên check-out → bắt buộc giờ ra (khớp BE: yêu cầu requested_check_out).
  .refine((d) => d.type !== "forgot_check_out" || !!d.check_out_time?.trim(), {
    message: "Vui lòng nhập giờ ra xin bổ sung",
    path: ["check_out_time"],
  })

type FormValues = z.infer<typeof schema>

/**
 * Form tạo đơn chấm công (thiết kế chamcong-mobile2): khối hạn mức tháng của loại đơn đang chọn,
 * lưới chọn loại đơn, ngày, giờ bổ sung (quên chấm), lý do; nút «Gửi đơn» ở thanh dính đáy (điện thoại)
 * / thanh nổi (desktop). Logic kiểm hợp lệ và API giữ nguyên.
 */
export function AttendanceRequestForm({
  userId,
  onSent,
}: {
  userId: number | undefined
  /** Gọi sau khi gửi đơn thành công (đưa sang màn «Đơn đã gửi»). */
  onSent?: (info: { typeLabel: string; dateDisplay: string }) => void
}) {
  const { data: config } = useRequestConfig()
  const createRequest = useCreateRequest()
  const mine = useAttendanceRequests({ page: 1, page_size: 100 })

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      work_date_display: "",
      // type không có default — nhóm chọn chưa có mục nào được đánh dấu
      type: undefined as unknown as AttendanceRequestType,
      check_in_time: "",
      check_out_time: "",
      reason: "",
    },
  })

  const watchedType = form.watch("type")
  const watchedDate = form.watch("work_date_display")
  const showCheckIn = NEEDS_CHECK_IN.includes(watchedType)
  const showCheckOut = NEEDS_CHECK_OUT.includes(watchedType)
  const errors = form.formState.errors

  // Khi chọn loại "quên chấm vào/ra", prefill giờ từ config
  useEffect(() => {
    if (watchedType === "forgot_check_in" && config?.default_check_in) {
      form.setValue("check_in_time", config.default_check_in)
    }
  }, [watchedType, config?.default_check_in]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (watchedType === "forgot_check_out" && config?.default_check_out) {
      form.setValue("check_out_time", config.default_check_out)
    }
  }, [watchedType, config?.default_check_out]) // eslint-disable-line react-hooks/exhaustive-deps

  // Hạn mức tháng của loại đang chọn (tháng theo ngày đã nhập, mặc định tháng này).
  const group = watchedType ? quotaGroupOf(watchedType) : null
  const month = (parseVnDate(watchedDate ?? "") ?? todayVn()).slice(0, 7)
  const quota =
    group && userId !== undefined
      ? quotaFor(userId, group, month, mine.data?.data ?? [], config)
      : null
  const quotaLabel = group ? QUOTA_GROUP_LABEL[group] : "Hạn mức tháng"
  const quotaText = !group
    ? "Chọn loại đơn"
    : quota && quota.max !== null
      ? `${quota.used} / ${quota.max} đơn`
      : "Không giới hạn theo đơn"

  function onSubmit(values: FormValues) {
    const work_date = parseVnDate(values.work_date_display)
    if (!work_date) return

    createRequest.mutate(
      {
        work_date,
        type: values.type,
        ...(showCheckIn && values.check_in_time
          ? { requested_check_in: values.check_in_time }
          : {}),
        ...(showCheckOut && values.check_out_time
          ? { requested_check_out: values.check_out_time }
          : {}),
        reason: values.reason,
      },
      {
        onSuccess: () => {
          toast.success("Đã gửi đơn, chờ duyệt")
          onSent?.({
            typeLabel: REQUEST_TYPE_LABEL[values.type] ?? values.type,
            dateDisplay: values.work_date_display,
          })
          form.reset()
        },
        onError: (err: unknown) => {
          // Lý do cụ thể của máy chủ (thiếu giờ, vượt hạn mức…) hoặc câu theo loại lỗi — bảng thông điệp chung.
          toast.error(errorMessage(err, "Chưa gửi được đơn"))
        },
      },
    )
  }

  const future = !!watchedType && FUTURE_DATE_ALLOWED_TYPES.includes(watchedType)

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
      <HeroCard compact className="flex items-center justify-between gap-3 rounded-[18px] px-[18px] py-3.5">
        <span className="text-sm text-[var(--ax-on-hero-ink-2)]">{quotaLabel}</span>
        <span className="ax-amount text-[17px] font-semibold tracking-[-0.011em] text-white">{quotaText}</span>
      </HeroCard>
      {quota?.over && (
        <p className="-mt-2 px-1 text-[13px] text-ax-warn">
          Bạn đã dùng hết hạn mức tháng này; đơn mới có thể bị máy chủ từ chối.
        </p>
      )}

      <div>
        <div id="att-type-label" className="sr-only">
          Loại đơn
        </div>
        <div
          role="radiogroup"
          aria-labelledby="att-type-label"
          className="grid grid-cols-2 gap-2 sm:grid-cols-3"
        >
          {REQUEST_TYPES.map(([value, label]) => {
            const on = watchedType === value
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => {
                  form.setValue("type", value, { shouldValidate: true })
                  // Re-check "Ngày làm việc" ngay khi đổi loại đơn — chuyển sang/khỏi "Nghỉ phép"
                  // phải cập nhật lỗi ngày tương lai tức thì (không đợi tới submit).
                  if (form.getValues("work_date_display")) void form.trigger("work_date_display")
                }}
                className={cn(
                  "min-h-14 cursor-pointer rounded-[10px] border-2 border-transparent bg-ax-surface px-2 py-1.5 text-[15px] font-semibold text-ax-ink outline-none transition-colors",
                  "shadow-[var(--ax-shadow-card)] hover:bg-ax-hover focus-visible:shadow-[var(--ax-focus-ring)]",
                  on && "border-ax-primary bg-[var(--ax-grad-soft)] text-ax-primary-ink",
                )}
              >
                {label}
              </button>
            )
          })}
        </div>
        {errors.type && (
          <p role="alert" className="mt-2 px-1 text-sm text-ax-danger">
            Chọn loại đơn trước.
          </p>
        )}
      </div>

      <AxField
        label="Ngày áp dụng"
        placeholder="DD/MM/YYYY"
        inputMode="numeric"
        error={errors.work_date_display?.message}
        hint={future ? "Nghỉ phép được chọn ngày sắp tới." : "Đơn này chỉ cho ngày đã qua, trước hôm nay."}
        {...form.register("work_date_display")}
        onChange={(e) => {
          const masked = autoMaskVnDate(e.target.value)
          form.setValue("work_date_display", masked, { shouldValidate: true })
        }}
      />

      {showCheckIn && (
        <AxField
          label="Giờ vào xin bổ sung"
          type="time"
          error={errors.check_in_time?.message}
          hint="Điền sẵn theo ca. Sửa nếu giờ thật khác."
          {...form.register("check_in_time")}
        />
      )}
      {showCheckOut && (
        <AxField
          label="Giờ ra xin bổ sung"
          type="time"
          error={errors.check_out_time?.message}
          hint="Điền sẵn theo ca. Sửa nếu giờ thật khác."
          {...form.register("check_out_time")}
        />
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor="att-reason" className="ax-text-label">
          Lý do
        </label>
        <textarea
          id="att-reason"
          placeholder="Một hai câu để quản lý duyệt nhanh"
          rows={3}
          aria-invalid={errors.reason ? true : undefined}
          className={cn(AX_INPUT_CLASS, "h-auto min-h-24 resize-none py-3 max-sm:h-auto")}
          {...form.register("reason")}
        />
        {errors.reason && (
          <p role="alert" className="text-sm text-ax-danger">
            {errors.reason.message}
          </p>
        )}
      </div>

      {/* Dưới 1024px: thanh đáy điện thoại; từ 1024px: thanh nổi căn phải. */}
      <StickyActionBar>
        <Button type="submit" variant="ax-primary" size="ax-lg" className="lg:px-8" disabled={createRequest.isPending}>
          {createRequest.isPending ? "Đang gửi..." : "Gửi đơn"}
        </Button>
      </StickyActionBar>
    </form>
  )
}
