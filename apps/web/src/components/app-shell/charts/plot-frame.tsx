/* Không cần `"use client"`: file này không có hook/handler nào. Import từ
 * component client là đủ để nó vào bundle client. */

import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/* =============================================================================
 * Khung TRỤC dùng chung cho biểu đồ có trục đứng (Area + Cột dọc):
 * lưới ngang đứt nét màu `--chart-grid`, nhãn trục 11px màu `--muted`,
 * `tickAmount: 4` (⇒ 5 vạch kể cả 0), KHÔNG vẽ đường trục đậm.
 *
 * Vì sao lưới + nhãn là DOM chứ không nằm trong SVG: vùng vẽ co giãn theo
 * bề rộng cha (`preserveAspectRatio="none"`), nên mọi thứ BÊN TRONG svg bị kéo
 * ngang theo — chữ sẽ méo và nét sẽ dày mỏng không đều. Giữ chữ/lưới ở DOM thì
 * chúng không bao giờ méo; riêng nét vẽ dữ liệu trong svg được ghim bằng
 * `vector-effect="non-scaling-stroke"`.
 *
 * ⚠️ Khung này giả định giá trị KHÔNG ÂM (mọi chỉ số của CRM là đếm hoặc tiền
 * ≥ 0). Có ca âm thì phải dựng lại phần chia tỉ lệ, đừng truyền đại vào.
 * ========================================================================== */

/** Số nhãn trục X tối đa trước khi thưa bớt (14 ngày · 24 giờ · 12 tháng…). */
const MAX_X_LABELS = 8

export interface ShellPlotFrameProps {
  /** Nhãn trục X theo đúng thứ tự dữ liệu. */
  categories: string[]
  /** Mốc trục Y (từ 0 tăng dần) — lấy từ `niceTicks`. */
  ticks: number[]
  /** Định dạng nhãn trục Y. */
  formatAxis: (v: number) => string
  /**
   * Điểm neo nhãn X:
   *  - `"point"` — đường/vùng: điểm đầu ở mép trái, điểm cuối ở mép phải.
   *  - `"band"`  — cột: mỗi hạng mục chiếm một dải, nhãn nằm giữa dải.
   */
  xAlign?: "point" | "band"
  height?: number
  /** Bề rộng cột nhãn trục Y. */
  axisWidth?: number
  /** Lớp vẽ dữ liệu — được đặt phủ kín đúng vùng vẽ (`absolute inset-0`). */
  children: ReactNode
  className?: string
}

/**
 * Chọn bước thưa nhãn X sao cho số nhãn hiện ra ≤ `MAX_X_LABELS`.
 *
 * Luôn hiện nhãn ĐẦU (i=0). KHÔNG ép hiện nhãn cuối: với bước không chia hết,
 * nhãn cuối sẽ nằm sát nhãn kề trước nó và đè chữ lên nhau — thà thiếu một
 * nhãn còn hơn in ra hai nhãn chồng nhau không đọc được (số chính xác luôn lấy
 * được ở nút "Bảng" của `ShellChartCard`).
 */
export function xLabelStep(count: number, max = MAX_X_LABELS): number {
  if (count <= max) return 1
  return Math.ceil(count / max)
}

export function ShellPlotFrame({
  categories,
  ticks,
  formatAxis,
  xAlign = "point",
  height = 230,
  axisWidth = 48,
  children,
  className,
}: ShellPlotFrameProps) {
  const top = ticks.length > 0 ? ticks[ticks.length - 1] : 0
  const step = xLabelStep(categories.length)

  return (
    <div
      className={cn("grid w-full gap-x-2 pt-4", className)}
      style={{ gridTemplateColumns: `${axisWidth}px minmax(0,1fr)` }}
    >
      {/* ── Cột nhãn trục Y ───────────────────────────────────────────────── */}
      <div className="relative" style={{ height }}>
        {ticks.map((t) => (
          <span
            key={t}
            className="absolute right-0 -translate-y-1/2 text-[14px] tabular-nums text-[var(--color-app-ink-2)]"
            style={{ bottom: `${top > 0 ? (t / top) * 100 : 0}%` }}
          >
            {formatAxis(t)}
          </span>
        ))}
      </div>

      {/* ── Vùng vẽ: lưới ngang đứt nét + lớp dữ liệu ─────────────────────── */}
      <div className="relative" style={{ height }}>
        {ticks.map((t) => (
          <div
            key={t}
            aria-hidden
            className="absolute inset-x-0 border-t border-dashed border-[var(--color-app-chart-grid)]"
            style={{ bottom: `${top > 0 ? (t / top) * 100 : 0}%` }}
          />
        ))}
        {children}
      </div>

      {/* ── Nhãn trục X ───────────────────────────────────────────────────── */}
      <span />
      <div className="relative mt-1.5 h-5">
        {categories.map((c, i) => {
          if (i % step !== 0) return null
          // MỘT mốc duy nhất thì đặt GIỮA — khớp chỗ `ShellArea` vẽ chấm (x=50).
          // Công thức `i/(n-1)` cho 0 ⇒ nhãn dạt sang mép trái trong khi chấm
          // nằm giữa: hai thứ mô tả cùng một điểm mà nằm hai nơi.
          const single = categories.length === 1
          const pos = single
            ? 50
            : xAlign === "band"
              ? ((i + 0.5) / categories.length) * 100
              : (i / (categories.length - 1)) * 100
          // Nhãn đầu/cuối neo vào mép để không tràn ra ngoài vùng vẽ.
          const atStart = !single && xAlign === "point" && i === 0
          const atEnd =
            !single && xAlign === "point" && i === categories.length - 1
          return (
            <span
              key={`${c}-${i}`}
              // Màn hẹp (điện thoại): chữ 14px không đủ chỗ cho mọi mốc ⇒ ẩn bớt một nửa (giữ mốc đầu).
              className={cn(
                "absolute whitespace-nowrap text-[14px] text-[var(--color-app-ink-2)]",
                categories.length > 4 && (i / step) % 2 === 1 && "max-sm:hidden",
              )}
              style={{
                left: `${pos}%`,
                transform: atStart
                  ? "none"
                  : atEnd
                    ? "translateX(-100%)"
                    : "translateX(-50%)",
              }}
            >
              {c}
            </span>
          )
        })}
      </div>
    </div>
  )
}
