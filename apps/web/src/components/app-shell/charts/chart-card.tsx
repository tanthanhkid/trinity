"use client"

import { useId, useState } from "react"
import { Table2, BarChart3 } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

/* =============================================================================
 * Khung thẻ BIỂU ĐỒ của giao diện v2.
 *
 * Nút "Bảng" KHÔNG phải trang trí: mỗi thẻ có nút **Bảng** để đọc số chính xác —
 * vừa là cách tra số, vừa là phương án dự phòng cho người khó phân biệt màu.
 *
 * Biểu đồ là lớp TRÌNH BÀY, bảng là lớp DỮ LIỆU luôn lấy được. Thêm một
 * biểu đồ mới mà không kèm `table` là bỏ mất đường đọc số của người dùng mù màu
 * ⇒ prop `table` để BẮT BUỘC (không optional) đúng vì lý do đó.
 *
 * Bảng render bằng thẻ `<table>` thật (không phải div giả bảng) để trình đọc
 * màn hình đọc được quan hệ hàng/cột; phần biểu đồ khi đó `hidden` hẳn chứ
 * không chỉ ẩn bằng CSS.
 * ========================================================================== */

export interface ShellChartTable {
  /** Tiêu đề cột. Cột đầu là hạng mục, các cột sau là số → canh phải. */
  columns: string[]
  /** Mỗi hàng khớp thứ tự `columns`. Giá trị đã format sẵn (chuỗi hiển thị). */
  rows: (string | number)[][]
}

export interface ShellChartCardProps {
  title: string
  subtitle?: string
  /** Dữ liệu thô của biểu đồ, hiện khi bấm "Bảng" (xem docblock). */
  table: ShellChartTable
  /** Thêm nút/bộ lọc riêng của thẻ, đặt bên trái nút "Bảng". */
  tools?: React.ReactNode
  /** Nội dung khi KHÔNG có dữ liệu — thay cho cả biểu đồ lẫn nút "Bảng". */
  empty?: React.ReactNode
  /**
   * Câu thay cho BIỂU ĐỒ khi có hàng dữ liệu nhưng hình vẽ ra vô nghĩa (điển
   * hình: mọi giá trị bằng 0 ⇒ toàn thanh cụt, trục 0–1).
   *
   * Khác `empty`: nút "Bảng" VẪN còn và bảng VẪN đầy đủ — dữ liệu có thật,
   * chỉ là chiều dài thanh không nói được gì. Ẩn luôn cả bảng ở ca này là
   * giấu mất số người dùng đang cần đọc.
   */
  chartNotice?: React.ReactNode
  className?: string
  children: React.ReactNode
}

export function ShellChartCard({
  title,
  subtitle,
  table,
  tools,
  empty,
  chartNotice,
  className,
  children,
}: ShellChartCardProps) {
  const [asTable, setAsTable] = useState(false)
  const panelId = useId()
  const isEmpty = table.rows.length === 0

  return (
    <section
      className={cn(
        "flex flex-col rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] shadow-[var(--shadow-card)]",
        className,
      )}
    >
      {/* .card-head — tít trái, cụm công cụ đẩy sang phải */}
      <header className="flex flex-wrap items-center gap-2.5 px-3.5 pt-3">
        <div className="min-w-0">
          <h3 className="truncate text-[15px] font-semibold leading-tight text-[var(--color-app-navy)]">
            {title}
          </h3>
          {/* 🔴 KHÔNG `truncate` phụ đề. Phụ đề của các thẻ v2 mang ĐỊNH NGHĨA
              của con số ("đếm theo hội thoại nên 1 khách nhắn 2 bot tính 2
              lần", "4 chỉ số ĐỘC LẬP, không cộng thành tổng"). Ở 11,5px trên
              thẻ ~360px một dòng chỉ chứa ~55-65 ký tự — cắt là mất đúng nửa
              câu cảnh báo, mà người đọc không biết mình đang thiếu gì. Cho
              xuống dòng; thẻ cao thêm vài px là cái giá rẻ hơn nhiều. */}
          {subtitle && (
            <p className="mt-0.5 text-[14px] leading-snug text-[var(--color-app-ink-2)]">
              {subtitle}
            </p>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {tools}
          {!isEmpty && (
            <Button
              type="button"
              size="sm"
              className="text-[14px]"
              // đang chọn ("Bảng" đang hiện) → tông nhạt `soft`,
              // KHÔNG nền đặc. Nút nghỉ là `outline` (viền `--input` đạt 3:1,).
              variant={asTable ? "soft" : "outline"}
              onClick={() => setAsTable((v) => !v)}
              aria-pressed={asTable}
              aria-controls={panelId}
            >
              {asTable ? (
                <BarChart3 className="size-3.5" aria-hidden />
              ) : (
                <Table2 className="size-3.5" aria-hidden />
              )}
              {asTable ? "Biểu đồ" : "Bảng"}
            </Button>
          )}
        </div>
      </header>

      <div id={panelId} className="flex-1 p-3.5 pt-3">
        {isEmpty ? (
          <p className="py-6 text-center text-[14px] text-[var(--color-app-ink-2)]">
            {empty ?? "Không có dữ liệu"}
          </p>
        ) : asTable ? (
          <ShellChartDataTable table={table} />
        ) : chartNotice ? (
          <p className="py-6 text-center text-[14px] text-[var(--color-app-ink-2)]">
            {chartNotice}
          </p>
        ) : (
          children
        )}
      </div>
    </section>
  )
}

/** Bảng số của thẻ biểu đồ — cột đầu là hạng mục, các cột sau canh phải. */
function ShellChartDataTable({ table }: { table: ShellChartTable }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[14px]">
        <thead>
          <tr className="border-b border-[var(--color-app-line)]">
            {table.columns.map((c, i) => (
              <th
                key={c}
                scope="col"
                className={cn(
                  "py-1.5 font-semibold text-[var(--color-app-ink-2)]",
                  i === 0 ? "text-left" : "text-right",
                )}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, ri) => (
            <tr
              key={`${String(row[0])}-${ri}`}
              className="border-b border-[var(--color-app-line-2)] last:border-0"
            >
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className={cn(
                    "py-1.5 text-[var(--color-app-navy)]",
                    ci === 0
                      ? "pr-3 text-left font-medium"
                      : "pl-3 text-right tabular-nums",
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
