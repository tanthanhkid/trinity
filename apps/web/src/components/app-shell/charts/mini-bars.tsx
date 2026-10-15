import { cn } from "@/lib/utils"

/* =============================================================================
 * Hình vẽ nhỏ trong thẻ chỉ số (cao 56px).
 *
 * Vẽ CẶP CỘT "hôm qua / hôm nay" (không phải đường xu hướng 14 ngày) vì đó là
 * thứ dữ liệu THẬT mà BE cấp ở endpoint này:
 * `/reports/dashboard-stats-today` trả ĐÚNG 2 mốc cho mỗi chỉ số
 * (`*_today` + `*_yesterday`) — không có chuỗi ngày. Vẽ 14 điểm từ 2 số là bịa
 * ra một đường xu hướng không tồn tại; ở màn Tổng quan mà bịa hình thì người
 * đọc sẽ ra quyết định theo cái hình đó.
 *
 * Muốn có đúng đường 14 ngày thì cần endpoint trả chuỗi ngày thật.
 *
 * Cột "hôm nay" tô đậm bằng tông của thẻ, cột "hôm qua" tô nhạt — mắt đọc được
 * chiều tăng/giảm ngay, còn con số chính xác vẫn nằm ở `.ct-v` và ở nhãn delta.
 * Cả khối là `role="img"` + `aria-label` đọc đủ 2 số: hình này KHÔNG phải đường
 * đọc số duy nhất cho trình đọc màn hình.
 * ========================================================================== */

const FLOOR_PCT = 6

export interface ShellMiniBarsProps {
  today: number
  yesterday: number
  /** Màu tô cột "hôm nay" — truyền token `var(--color-app-*)`. */
  fill: string
  /** Định dạng số cho `aria-label` (mặc định nhóm nghìn kiểu VN). */
  format?: (value: number) => string
  className?: string
}

export function ShellMiniBars({
  today,
  yesterday,
  fill,
  format = (v) => v.toLocaleString("vi-VN"),
  className,
}: ShellMiniBarsProps) {
  const a = Number.isFinite(yesterday) && yesterday > 0 ? yesterday : 0
  const b = Number.isFinite(today) && today > 0 ? today : 0
  const max = Math.max(a, b)

  // Cả hai bằng 0 → 2 cột SÀN bằng nhau (không chia cho 0, và không vẽ ra
  // chênh lệch giả). Còn lại: quy về % của giá trị lớn hơn, nhưng giá trị > 0
  // luôn được ít nhất FLOOR_PCT để không biến mất thành vạch 0px.
  const pct = (v: number) => {
    if (max === 0) return FLOOR_PCT
    const raw = (v / max) * 100
    return v > 0 ? Math.max(FLOOR_PCT, raw) : 0
  }

  return (
    <div
      role="img"
      aria-label={`Hôm qua ${format(yesterday)}, hôm nay ${format(today)}`}
      className={cn("flex h-14 items-end gap-2 px-0.5", className)}
    >
      {/* 🔴 Cột "hôm qua" CỐ Ý nhạt (nó là mốc tham chiếu, không phải trọng tâm)
          nhưng nền nhạt đó đo trên thẻ trắng chỉ **1,46:1** — dưới chuẩn ĐỒ HOẠ
          3:1, tức gần như vô hình với người thị lực kém, mà so sánh chính là lý
          do tồn tại của hình này . Giữ nền nhạt + thêm
          VIỀN `--color-app-chart-seq-6` (**4,86:1** trên trắng): ranh giới đủ rõ
          để nhận ra cột, sắc độ vẫn nói đúng "đây là mốc cũ". */}
      <Bar
        heightPct={pct(a)}
        label="Hôm qua"
        tone="bg-[var(--color-app-chart-seq-2)] border border-[var(--color-app-chart-seq-6)]"
      />
      <Bar heightPct={pct(b)} label="Hôm nay" style={{ backgroundColor: fill }} />
    </div>
  )
}

function Bar({
  heightPct,
  label,
  tone,
  style,
}: {
  heightPct: number
  label: string
  tone?: string
  style?: React.CSSProperties
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-stretch gap-1">
      <div className="flex h-9 items-end">
        <div
          aria-hidden
          className={cn("w-full rounded-t-[3px]", tone)}
          style={{ height: `${heightPct}%`, ...style }}
        />
      </div>
      <span
        aria-hidden
        className="truncate text-center text-sm leading-none text-[var(--color-app-ink-2)]"
      >
        {label}
      </span>
    </div>
  )
}
