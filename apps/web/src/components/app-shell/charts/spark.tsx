import { useId } from "react"
import { cn } from "@/lib/utils"
import { formatDate } from '@/lib/format'

/* =============================================================================
 * Đường xu hướng 14 ngày trong thẻ chỉ số (cao 56px), dữ liệu từ endpoint
 * `GET /reports/dashboard-trend-14d` (chuỗi ngày THẬT; không nội suy từ ít điểm
 * hơn vì như vậy là bịa xu hướng).
 *
 * Vẽ bằng SVG thuần, KHÔNG thêm thư viện: mỗi thẻ chỉ cần 1 đường + 1 vùng tô,
 * còn trang có tới 13 thẻ — nạp cả thư viện biểu đồ cho 13 sparkline là đắt hơn
 * nhiều so với thứ nó vẽ.
 *
 * Quy ước đọc: điểm CUỐI là hôm nay (khớp `days[]` của BE, CŨ → MỚI). Toàn
 * chuỗi bằng 0 (chưa phát sinh) vẫn vẽ ĐƯỜNG PHẲNG ở đáy chứ không ẩn thẻ —
 * tức là chưa có dữ liệu thì thẻ vẫn hiện đầy đủ với đường xu hướng phẳng ở 0,
 * không ẩn thẻ.
 * ========================================================================== */

export interface ShellSparkProps {
  /** Chuỗi giá trị CŨ → MỚI; điểm cuối là hôm nay. */
  values: number[]
  /** Nhãn ngày `YYYY-MM-DD` khớp `values` — dùng cho `aria-label`. */
  days?: string[]
  /** Màu đường — truyền token `var(--color-app-*)` theo tông của thẻ. */
  stroke: string
  /** Định dạng số cho `aria-label` (mặc định nhóm nghìn bằng dấu chấm kiểu VN). */
  format?: (value: number) => string
  className?: string
}

const H = 56
const W = 200 // toạ độ nội bộ; `preserveAspectRatio="none"` kéo đầy bề ngang thẻ
const PAD_TOP = 6 // chừa chỗ cho nét vẽ ở đỉnh, không bị cắt ngọn

/**
 * Nhóm nghìn bằng dấu chấm, KHÔNG dùng `toLocaleString`: locale của máy
 * quyết định dấu phân cách, nên cùng một số ra 2 kiểu trên 2 máy. Ở đây chỉ
 * phục vụ `aria-label` nên tự nhóm là đủ và tất định.
 */
function groupVn(v: number): string {
  return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ".")
}

/** Đường gấp khúc làm mượt bằng Catmull-Rom → Bézier, giống nét của bản mẫu. */
function smoothPath(pts: Array<[number, number]>): string {
  if (pts.length === 0) return ""
  if (pts.length === 1) return `M ${pts[0][0]} ${pts[0][1]}`
  let d = `M ${pts[0][0]} ${pts[0][1]}`
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? p2
    const c1x = p1[0] + (p2[0] - p0[0]) / 6
    const c1y = p1[1] + (p2[1] - p0[1]) / 6
    const c2x = p2[0] - (p3[0] - p1[0]) / 6
    const c2y = p2[1] - (p3[1] - p1[1]) / 6
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2[0]} ${p2[1]}`
  }
  return d
}

export function ShellSpark({ values, days, stroke, format, className }: ShellSparkProps) {
  const gradientId = useId()
  const fmt = format ?? groupVn
  const n = values.length

  if (n === 0) return <div className={cn("h-14", className)} aria-hidden />

  // KHÔNG `Math.max(...arr)` — toán tử `...` trải mảng thành THAM SỐ hàm,
  // mảng lớn là `RangeError`. Ở đây mảng luôn 14 phần tử nên vẫn an toàn, nhưng
  // giữ dạng `reduce` để không ai copy mẫu này sang chỗ mảng không chặn trên.
  const max = values.reduce((m, v) => (v > m ? v : m), values[0])
  const min = values.reduce((m, v) => (v < m ? v : m), values[0])
  // Dải 0 (mọi ngày bằng nhau, kể cả toàn 0) → vẽ phẳng ở ĐÁY, không chia cho 0.
  const span = max - min
  const y = (v: number) =>
    span === 0 ? H - 2 : PAD_TOP + (1 - (v - min) / span) * (H - PAD_TOP - 2)
  const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W)

  const pts: Array<[number, number]> = values.map((v, i) => [x(i), y(v)])
  const line = smoothPath(pts)
  const area = `${line} L ${W} ${H} L 0 ${H} Z`

  const last = values[n - 1]
  const first = values[0]
  // Ngày đọc cho người dùng phải là dd/mm/yyyy — `days[]` từ BE là ISO
  // `YYYY-MM-DD`. Dùng `formatDate` của `@/lib/format` (quy ước KHÔNG
  // `toLocaleDateString`, drift giữa các trình duyệt).
  const label = days?.length
    ? `Xu hướng ${n} ngày, từ ${formatDate(days[0])} đến ${formatDate(days[n - 1])}: ${fmt(first)} → ${fmt(last)}`
    : `Xu hướng ${n} ngày: ${fmt(first)} → ${fmt(last)}`

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={cn("h-14 w-full", className)}
      role="img"
      aria-label={label}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
