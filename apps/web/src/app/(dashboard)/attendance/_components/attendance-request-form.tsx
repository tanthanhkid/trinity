"use client"

import { useEffect } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "sonner"
import { Send } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { MobileActionBar } from "@/components/app-shell/mobile-action-bar"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { autoMaskVnDate, parseVnDate, todayVn } from "@/lib/format"
import {
  REQUEST_TYPE_LABEL,
  useCreateRequest,
  useRequestConfig,
  type AttendanceRequestType,
} from "@/hooks/use-attendance"

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

export function AttendanceRequestForm() {
  const { data: config } = useRequestConfig()
  const createRequest = useCreateRequest()

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      work_date_display: "",
      // type không có default — dùng undefined để Select hiện placeholder
      type: undefined as unknown as AttendanceRequestType,
      check_in_time: "",
      check_out_time: "",
      reason: "",
    },
  })

  const watchedType = form.watch("type")
  const showCheckIn = NEEDS_CHECK_IN.includes(watchedType)
  const showCheckOut = NEEDS_CHECK_OUT.includes(watchedType)

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
          form.reset()
        },
        onError: (err: unknown) => {
          // Hiện đúng lý do từ BE (vd thiếu giờ, vượt hạn mức) thay vì thông báo chung chung.
          const data = (err as { response?: { data?: { message?: unknown } } })
            ?.response?.data?.message
          const msg =
            typeof data === "string"
              ? data
              : Array.isArray(data) && typeof data[0] === "string"
                ? data[0]
                : "Gửi đơn thất bại, vui lòng thử lại"
          toast.error(msg)
        },
      },
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tạo đơn chấm công</CardTitle>
      </CardHeader>
      <CardContent>
        {/* Thông tin hạn mức (informational) */}
        {config && (
          <div className="mb-5 rounded-md bg-muted px-4 py-3 text-sm text-muted-foreground">
            <p>
              Giờ vào mặc định:{" "}
              <span className="font-medium text-foreground">{config.default_check_in}</span>
              {" · "}Giờ ra mặc định:{" "}
              <span className="font-medium text-foreground">{config.default_check_out}</span>
            </p>
            <p className="mt-0.5">
              Hạn mức tháng — Quên chấm:{" "}
              <span className="font-medium text-foreground">
                {config.monthly_forgot_limit} đơn
              </span>
              {" · "}Đến muộn / Về sớm:{" "}
              <span className="font-medium text-foreground">
                {config.monthly_late_early_limit} đơn
              </span>
            </p>
          </div>
        )}

        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="space-y-4"
          noValidate
        >
          {/* Ngày làm việc */}
          <div className="space-y-1.5">
            <Label htmlFor="work_date_display">
              Ngày làm việc <span className="text-destructive">*</span>
            </Label>
            <Input
              id="work_date_display"
              placeholder="DD/MM/YYYY"
              inputMode="numeric"
              className="max-sm:h-11"
              {...form.register("work_date_display")}
              onChange={(e) => {
                const masked = autoMaskVnDate(e.target.value)
                form.setValue("work_date_display", masked, { shouldValidate: true })
              }}
            />
            {form.formState.errors.work_date_display && (
              <p className="text-xs text-destructive">
                {form.formState.errors.work_date_display.message}
              </p>
            )}
          </div>

          {/* Loại đơn */}
          <div className="space-y-1.5">
            <Label>
              Loại đơn <span className="text-destructive">*</span>
            </Label>
            <Select
              value={watchedType}
              onValueChange={(v) => {
                form.setValue("type", v as AttendanceRequestType, {
                  shouldValidate: true,
                })
                // Re-check "Ngày làm việc" ngay khi đổi loại đơn — chuyển
                // sang/khỏi "Nghỉ phép" phải cập nhật lỗi ngày tương lai tức thì
                // (không đợi tới submit).
                if (form.getValues("work_date_display")) {
                  void form.trigger("work_date_display")
                }
              }}
            >
              <SelectTrigger className="w-full max-sm:h-11">
                <SelectValue placeholder="Chọn loại đơn">
                  {(v) => {
                    if (typeof v !== "string" || !v) return null
                    return REQUEST_TYPE_LABEL[v] ?? null
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {REQUEST_TYPES.map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.formState.errors.type && (
              <p className="text-xs text-destructive">
                {form.formState.errors.type.message}
              </p>
            )}
          </div>

          {/* Giờ vào — chỉ hiện khi loại = forgot_check_in */}
          {showCheckIn && (
            <div className="space-y-1.5">
              <Label htmlFor="check_in_time">
                Giờ vào xin bổ sung <span className="text-destructive">*</span>
              </Label>
              <Input
                id="check_in_time"
                type="time"
                className="max-sm:h-11"
                {...form.register("check_in_time")}
              />
              {form.formState.errors.check_in_time && (
                <p className="text-xs text-destructive">
                  {form.formState.errors.check_in_time.message}
                </p>
              )}
            </div>
          )}

          {/* Giờ ra — chỉ hiện khi loại = forgot_check_out */}
          {showCheckOut && (
            <div className="space-y-1.5">
              <Label htmlFor="check_out_time">
                Giờ ra xin bổ sung <span className="text-destructive">*</span>
              </Label>
              <Input
                id="check_out_time"
                type="time"
                className="max-sm:h-11"
                {...form.register("check_out_time")}
              />
              {form.formState.errors.check_out_time && (
                <p className="text-xs text-destructive">
                  {form.formState.errors.check_out_time.message}
                </p>
              )}
            </div>
          )}

          {/* Lý do */}
          <div className="space-y-1.5">
            <Label htmlFor="reason">
              Lý do <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="reason"
              placeholder="Nhập lý do..."
              rows={3}
              className="max-sm:min-h-24"
              {...form.register("reason")}
            />
            {form.formState.errors.reason && (
              <p className="text-xs text-destructive">
                {form.formState.errors.reason.message}
              </p>
            )}
          </div>

          {/* <640px — "Gửi đơn" dính đáy, là nút chính DUY NHẤT của tab này
              (thanh Chấm công vào/ra đã ẩn ở tab Tạo đơn). Desktop giữ outline như cũ;
              trên điện thoại ép sang nền đặc bằng `max-sm:` để không đổi desktop. */}
          <MobileActionBar className="sm:mb-0 sm:justify-start">
            <Button
              type="submit"
              variant="outline"
              disabled={createRequest.isPending}
              className="w-full max-sm:border-transparent max-sm:bg-primary max-sm:text-primary-foreground max-sm:hover:bg-primary/80 max-sm:hover:text-primary-foreground sm:w-auto"
            >
              <Send className="mr-2 h-4 w-4" />
              {createRequest.isPending ? "Đang gửi..." : "Gửi đơn"}
            </Button>
          </MobileActionBar>
        </form>
      </CardContent>
    </Card>
  )
}
