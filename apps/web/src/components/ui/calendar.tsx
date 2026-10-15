"use client"

/**
 * Lịch dùng chung (shadcn pattern trên `react-day-picker` v9).
 * Tiếng Việt hoàn toàn: tuần bắt đầu Thứ Hai, thứ `T2..T7/CN`, tiêu đề
 * "Tháng 10, 2026". "Hôm nay" theo giờ VN (`todayVn`), không theo đồng hồ máy.
 * Màu theo token app (`primary`/`accent`/`muted`) nên tự theo giao diện xanh dương.
 * Chỉ làm việc với `Date` — quy đổi sang/từ ISO `YYYY-MM-DD` ở `@/lib/date-iso`.
 */
import * as React from "react"
import { ChevronLeftIcon, ChevronRightIcon, ChevronDownIcon } from "lucide-react"
import { DayPicker, type ChevronProps, type DayPickerProps } from "react-day-picker"
import { vi } from "date-fns/locale/vi"
import { cn } from "@/lib/utils"
import { todayVnDate } from "@/lib/date-iso"

const WEEKDAY_VI = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"]

export const calendarFormatters = {
  formatCaption: (month: Date) => `Tháng ${month.getMonth() + 1}, ${month.getFullYear()}`,
  formatMonthDropdown: (month: Date) => `Tháng ${month.getMonth() + 1}`,
  formatYearDropdown: (year: Date) => String(year.getFullYear()),
  formatWeekdayName: (day: Date) => WEEKDAY_VI[day.getDay()],
}

function CalendarChevron({ orientation, className, ...props }: ChevronProps) {
  const Icon =
    orientation === "left" ? ChevronLeftIcon : orientation === "right" ? ChevronRightIcon : ChevronDownIcon
  return <Icon className={cn("size-4", className)} {...props} />
}

const pad2 = (n: number) => String(n).padStart(2, "0")
const CELL = "size-9 sm:size-8"

export function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  formatters,
  labels,
  components,
  ...props
}: DayPickerProps) {
  return (
    <DayPicker
      locale={vi}
      weekStartsOn={1}
      today={todayVnDate()}
      showOutsideDays={showOutsideDays}
      formatters={{ ...calendarFormatters, ...formatters }}
      labels={{
        labelPrevious: () => "Xem tháng trước",
        labelNext: () => "Xem tháng sau",
        labelMonthDropdown: () => "Chọn tháng",
        labelYearDropdown: () => "Chọn năm",
        labelDayButton: (day: Date) => `Ngày ${pad2(day.getDate())}/${pad2(day.getMonth() + 1)}/${day.getFullYear()}`,
        ...labels,
      }}
      className={cn("p-1 text-sm", className)}
      classNames={{
        root: "w-fit",
        months: "relative flex flex-col gap-4 sm:flex-row",
        month: "flex w-full flex-col gap-3",
        nav: "absolute inset-x-0 top-0 flex h-8 items-center justify-between",
        button_previous:
          "z-10 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 outline-none disabled:opacity-40",
        button_next:
          "z-10 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 outline-none disabled:opacity-40",
        month_caption: "flex h-8 items-center justify-center px-9",
        caption_label: "text-sm font-semibold select-none",
        dropdowns: "flex items-center justify-center gap-1.5 text-sm font-semibold",
        dropdown_root:
          "relative inline-flex items-center rounded-md px-1.5 py-1 hover:bg-muted focus-within:ring-3 focus-within:ring-ring/50",
        dropdown: "absolute inset-0 cursor-pointer opacity-0",
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: cn(CELL, "flex items-center justify-center text-xs font-medium text-muted-foreground"),
        week: "mt-1 flex w-full",
        day: cn(CELL, "p-0 text-center text-sm select-none"),
        day_button: cn(
          CELL,
          "inline-flex items-center justify-center rounded-md font-normal transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
        ),
        today: "[&>button]:font-bold [&>button]:text-primary [&>button]:ring-1 [&>button]:ring-primary/40",
        selected:
          "[&>button]:bg-primary [&>button]:text-primary-foreground [&>button]:hover:bg-primary [&>button]:hover:text-primary-foreground [&>button]:ring-0",
        range_start: "rounded-l-md bg-primary/10 [&>button]:rounded-r-none",
        range_end: "rounded-r-md bg-primary/10 [&>button]:rounded-l-none",
        range_middle:
          "bg-primary/10 [&>button]:rounded-none [&>button]:bg-transparent [&>button]:text-foreground [&>button]:hover:bg-primary/15",
        outside: "[&>button]:text-muted-foreground/50",
        disabled: "[&>button]:pointer-events-none [&>button]:text-muted-foreground/40 [&>button]:opacity-50",
        hidden: "invisible",
        ...classNames,
      }}
      components={{ Chevron: CalendarChevron, ...components }}
      {...props}
    />
  )
}
