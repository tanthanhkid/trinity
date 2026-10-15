"use client"

import { cn } from "@/lib/utils"
import { niceCeil, niceTicks } from "./chart-data"

/* =============================================================================
 * Thanh NGANG — dùng cho phễu bán hàng, xếp hạng nhân viên, lý do thất bại…
 * Vẽ bằng DOM + CSS (không dùng thư viện biểu đồ).
 *
 * Vì sao KHÔNG kéo thư viện biểu đồ (ApexCharts…) vào:
 *   · `apps/web` hiện KHÔNG có thư viện biểu đồ nào — thêm một cái là thêm
 *     ~500 KB vào bundle cho 5 biểu đồ.
 *   · App build `output: "standalone"` nên phụ thuộc runtime phải được trace
 *     vào bundle — hỏng ở runtime, không hỏng lúc build.
 *   · 3 dạng biểu đồ đang cần (thanh ngang, vành khuyên, tỉ lệ) vẽ bằng DOM/SVG
 *     thuần chỉ vài chục dòng và ăn theo được token màu + dark/zoom của app.
 * Cần biểu đồ tương tác thật (zoom, brush, realtime) thì hãy bàn lại — đừng
 * nhét dần thư viện vào chỉ để vẽ thêm một thanh.
 *
 * Nhãn trục + lưới đứt nét dùng `--chart-grid`, `strokeDashArray: 4`.
 * ========================================================================== */

export interface ShellBarHItem {
  label: string
  value: number
  /** Màu tô (mặc định teal thương hiệu). Truyền `var(--color-app-chart-N)`. */
  color?: string
  /** Chú thích phụ hiện sau giá trị, vd "42%". */
  note?: string
}

export interface ShellBarHProps {
  items: ShellBarHItem[]
  /** Format giá trị hiển thị. Mặc định: số nguyên kiểu vi-VN. */
  formatValue?: (v: number) => string
  /** Bề rộng cột nhãn bên trái. */
  labelWidth?: number
  /** Số vạch trục (kể cả 0). */
  ticks?: number
  className?: string
}

const DEFAULT_FORMAT = (v: number) => Math.round(v).toLocaleString("vi-VN")

/* `niceCeil`/`niceTicks` ĐÃ DỜI sang `chart-data.ts` (tầng hàm thuần) vì
 * Area/Cột dọc/Heatmap cũng cần đúng 2 hàm này — để lại trong file component
 * thì 3 primitive kia phải import một module `"use client"` chỉ để lấy 2 hàm
 * số học. Re-export ở đây để mọi chỗ đang `import { niceCeil } from ".../bar-h"`
 * (kể cả test) không phải sửa. */
export { niceCeil, niceTicks }

export function ShellBarH({
  items,
  formatValue = DEFAULT_FORMAT,
  labelWidth = 104,
  ticks = 5,
  className,
}: ShellBarHProps) {
  const max = niceCeil(items.map((i) => i.value))
  const tickValues = niceTicks(max, ticks)

  return (
    <div className={cn("w-full", className)}>
      {/* 3 CỘT: nhãn · vùng vẽ · giá trị.
          Giá trị để RIÊNG một cột thay vì đặt chồng lên thanh: 5/7 màu của dải
          teal + màu mặc định đều dưới AA với chữ trắng (vd `#d2efeb` chỉ
          1,21:1). Chữ đậm nằm NGOÀI thanh thì màu tô không còn ảnh hưởng tới
          việc đọc số, và số tiền dài không tràn ra khỏi thanh. */}
      <div
        className="grid items-center gap-x-2 gap-y-2"
        style={{ gridTemplateColumns: `${labelWidth}px minmax(0,1fr) auto` }}
      >
        {items.map((item) => {
          const pct = max > 0 ? Math.min(100, (item.value / max) * 100) : 0
          return (
            <div key={item.label} className="contents">
              <span
                className="truncate pr-0.5 text-right text-sm text-[var(--color-app-ink-2)]"
                title={item.label}
              >
                {item.label}
              </span>
              <div className="h-[22px] w-full">
                <div
                  className="h-full rounded-[5px] transition-[width] duration-300"
                  style={{
                    width: `${pct}%`,
                    minWidth: item.value > 0 ? 3 : 0,
                    background: item.color ?? "var(--color-app-chart-1)",
                  }}
                />
              </div>
              <span className="whitespace-nowrap text-sm font-semibold tabular-nums text-[var(--color-app-navy)]">
                {formatValue(item.value)}
                {item.note && (
                  <span className="ml-1 font-normal text-[var(--color-app-ink-2)]">
                    {item.note}
                  </span>
                )}
              </span>
            </div>
          )
        })}
      </div>

      {/* Trục giá trị — lưới đứt nét + nhãn, mirror `grid()` của thiết kế.
          Cột 3 để trống để trục thẳng hàng với đúng vùng vẽ. */}
      <div
        className="mt-1.5 grid gap-x-2"
        style={{ gridTemplateColumns: `${labelWidth}px minmax(0,1fr) auto` }}
      >
        <span />
        <div className="relative h-4 border-t border-dashed border-[var(--color-app-chart-grid)]">
          {tickValues.map((t, i) => (
            <span
              key={t}
              className="absolute top-0.5 text-sm tabular-nums text-[var(--color-app-ink-2)]"
              style={{
                left: `${(i / Math.max(1, tickValues.length - 1)) * 100}%`,
                transform:
                  i === 0
                    ? "none"
                    : i === tickValues.length - 1
                      ? "translateX(-100%)"
                      : "translateX(-50%)",
              }}
            >
              {formatValue(t)}
            </span>
          ))}
        </div>
        <span />
      </div>
    </div>
  )
}
