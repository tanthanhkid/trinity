"use client"

import { cn } from "@/lib/utils"

/* =============================================================================
 * Vòng TỈ LỆ (radial gauge) — "Tỷ lệ chốt deal", "Tỷ lệ phản hồi", "Hoàn thành
 * mục tiêu tháng". Vẽ bằng SVG thuần; lý do
 * không dùng thư viện biểu đồ ghi ở `bar-h.tsx`.
 *
 * Mirror thông số thiết kế: lõi rỗng 56%, rãnh nền `--surface-3`, đầu cung bo
 * tròn (`lineCap: 'round'`), số giữa 21px đậm, nhãn 11px nhạt.
 *
 * 🔴 Vòng này CHỈ dùng cho ĐÚNG MỘT tỉ lệ phần trăm. Muốn so 2–3 hạng mục thì
 * dùng `ShellBarH` — nhiều vòng đồng tâm là kiểu biểu đồ mà mắt không so được độ
 * dài cung (bán kính khác nhau ⇒ cùng % ra cung dài khác nhau).
 * ========================================================================== */

export interface ShellRadialProps {
  /** Giá trị phần trăm (0–100). Vượt 100 vẫn in số thật, cung vẽ đầy. */
  value: number
  /** Nhãn nhỏ dưới số giữa, vd "Tỷ lệ duyệt". */
  label?: string
  /** Màu cung (mặc định teal thương hiệu). Dùng token trạng thái khi có ngưỡng. */
  color?: string
  size?: number
  thickness?: number
  /**
   * Dòng chú thích dưới vòng — nơi đặt 2 con số gốc sinh ra tỉ lệ
   * ("5.786 / 10.520 đơn"). Thiếu nó thì người đọc không biết 55% của bao
   * nhiêu: 55% của 20 đơn và của 20.000 đơn là hai câu chuyện khác hẳn.
   */
  caption?: string
  className?: string
}

export function ShellRadial({
  value,
  label,
  color = "var(--color-app-chart-1)",
  size = 188,
  thickness = 18,
  caption,
  className,
}: ShellRadialProps) {
  // CUNG kẹp trong [0,100]; SỐ in ra đi thẳng từ `value` GỐC. Nếu ép `value`
  // không hợp lệ về 0 rồi mới format thì nhánh "—" của `formatPercent` không
  // bao giờ chạy được từ component, và tỉ lệ CHƯA XÁC ĐỊNH (0/0 — sáng thứ Hai chưa có đơn nào) in ra "0%", đọc thành "có đơn mà
  // không đơn nào hoàn thành". Đúng lớp luật null-vs-0 của dự án.
  const clamped = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0

  const r = (size - thickness) / 2
  const circumference = 2 * Math.PI * r
  const dash = (clamped / 100) * circumference

  return (
    <div className={cn("flex flex-col items-center gap-2", className)}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          /* `presentation` chứ không `img`+aria-label: số, nhãn và dòng chú
             thích đều là văn bản THẬT ngay dưới đây, gắn thêm nhãn cho svg là
             trình đọc màn hình đọc lặp 2 lần. Cùng cách với `donut.tsx`. */
          role="presentation"
        >
          {/* Rãnh nền — luôn vẽ đủ vòng để thấy được phần CÒN THIẾU */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            /* Đúng màu rãnh của thiết kế (`--surface-3`). ĐO THẬT: rãnh vs
               cung teal 2,95:1 và rãnh vs thẻ trắng 1,15:1 — KHÔNG đạt 3:1 của
               WCAG 1.4.11, và không màu nào đạt được CẢ HAI phía (đậm hơn thì
               mất tương phản với cung, nhạt hơn thì mất với nền thẻ). Vì vậy
               vòng này KHÔNG BAO GIỜ là đường đọc số duy nhất: con số luôn in ở
               giữa và `caption` mang 2 số gốc. */
            stroke="var(--color-app-surface-3)"
            strokeWidth={thickness}
          />
          {clamped > 0 && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={color}
              strokeWidth={thickness}
              strokeLinecap="round"
              strokeDasharray={`${dash} ${circumference - dash}`}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          )}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[21px] font-bold leading-none tabular-nums text-[var(--color-app-navy)]">
            {formatPercent(value)}
          </span>
          {label && (
            <span className="mt-1 text-[14px] text-[var(--color-app-ink-2)]">{label}</span>
          )}
        </div>
      </div>
      {caption && (
        <p className="text-center text-[14px] text-[var(--color-app-ink-2)]">{caption}</p>
      )}
    </div>
  )
}

/**
 * Một chữ số thập phân, dấu phẩy kiểu Việt — "52,6%".
 *
 * KHÔNG đi qua API bản địa hoá nào và cũng không cần: đây là số đã chặn
 * ở 1 chữ số thập phân, không có nhóm hàng nghìn nào để phân cách.
 */
export function formatPercent(v: number): string {
  if (!Number.isFinite(v)) return "—"
  const rounded = Math.round(v * 10) / 10
  return `${String(rounded).replace(".", ",")}%`
}

/**
 * Màu theo NGƯỠNG trạng thái (good/warn/bad).
 *
 * ⚠️ Dùng kèm NHÃN CHỮ, đừng để màu là tín hiệu duy nhất (WCAG 1.4.1).
 */
export function statusColor(pct: number, good: number, warn: number): string {
  if (pct >= good) return "var(--color-app-chart-good)"
  if (pct >= warn) return "var(--color-app-chart-warn)"
  return "var(--color-app-chart-bad)"
}

/** Nhãn chữ đi kèm `statusColor` — cùng ngưỡng, để màu không đứng một mình. */
export function statusLabel(pct: number, good: number, warn: number): string {
  if (pct >= good) return "đạt"
  if (pct >= warn) return "cần theo dõi"
  return "dưới ngưỡng"
}
