"use client"

import { ShellChartCard } from "./chart-card"
import { ShellBarH } from "./bar-h"
import { ShellDonut } from "./donut"
import { ShellRadial, formatPercent } from "./radial"
import { formatChartNumber, withSequentialColors } from "./chart-data"
import { categoryColor, CHART_NEUTRAL, withRankColors } from "./chart-colors"

/* =============================================================================
 * Khối BIỂU ĐỒ dùng cho 8 màn NGOÀI Trung tâm báo cáo:
 * Lương · Chấm công · Thống kê
 * bảo hiểm · Doanh số nhân viên.
 *
 * 🔴 Đặt ở `components/app-shell/charts/` chứ không trong một màn cụ thể: 8 màn này
 * nằm rải ở 8 nhánh route khác nhau, không màn nào là "chủ". Để trong một màn
 * thì 7 màn còn lại phải import chéo — đúng kiểu dây nhợ cần tránh.
 *
 * ⚠️ Khác các tab báo cáo, phần lớn màn ở đây có ô số nằm CẠNH một bảng/danh
 * sách đã đầy đủ số. Nguyên tắc áp dụng: chỉ thay bằng biểu đồ khi con số có
 * CHIỀU để vẽ (thành phần của một tổng, một tỉ lệ, một xếp hạng). Số đếm đơn
 * lẻ không có chiều nào thì giữ nguyên dạng thẻ và nói rõ vì sao — dựng hình
 * cho nó là bịa ra một hình không tồn tại.
 * ========================================================================== */

/** Một hạng mục của biểu đồ thành phần. */
export interface SharePart {
  label: string
  value: number
  /** Mặc định theo thứ tự bảng màu danh mục. */
  color?: string
}

/**
 * Thẻ "các phần của MỘT tổng" — vành khuyên + bảng.
 *
 * Chỉ dùng khi các phần THẬT SỰ cộng lại thành `total`. Không chắc thì dùng
 * `ShellCompareCard` (thanh so sánh) — vành khuyên ngụ ý 100%, và đó là lời
 * khẳng định về dữ liệu chứ không phải lựa chọn thẩm mỹ.
 */
export function ShellShareCard({
  title,
  subtitle,
  parts,
  total,
  unit = "",
  extraRows = [],
  emptyText = "Chưa có dữ liệu",
  className,
}: {
  title: string
  subtitle?: string
  parts: SharePart[]
  /** Tổng để đối chiếu; chênh lệch được hiện thành lát "Khác". */
  total?: number
  unit?: string
  /**
   * Số KHÁC ĐƠN VỊ nên không vào được vành khuyên (vd tổng thời lượng bên
   * cạnh số lượng) — nhưng vẫn phải có đường đọc. Để ở phụ đề là chưa đủ:
   * bấm "Bảng" thì phụ đề biến mất cùng biểu đồ, đúng lúc người dùng đang cần
   * tra số chính xác.
   */
  extraRows?: [string, string][]
  emptyText?: string
  className?: string
}) {
  const sum = parts.reduce((s, p) => s + (p.value > 0 ? p.value : 0), 0)
  const rest = total != null && total > sum ? total - sum : 0
  /* Chiều NGƯỢC LẠI cũng xảy ra: tổng các phần LỚN HƠN `total`. Gặp khi
   * `total` là con số ƯỚC LƯỢNG (vd `reltuples` của một bảng lớn) hoặc khi các lát
   * đến từ những câu đếm chạy ở thời điểm khác nhau. Im lặng thì vành khuyên
   * chia % trên `sum` trong khi dòng "Tổng" in `total` NHỎ HƠN tổng các cột và
   * vẫn ghi "100%" — bảng tự mâu thuẫn mà không ai biết. Nói thẳng ra. */
  const overflow = total != null && sum > total ? sum - total : 0
  const items = [
    ...parts.map((p, i) => ({ ...p, color: p.color ?? categoryColor(i) })),
    // Chênh lệch là CÓ THẬT khi `total` lớn hơn tổng các phần — im lặng bỏ qua
    // thì tổng vành khuyên không khớp con số in ở phụ đề.
    ...(rest > 0 ? [{ label: "Khác", value: rest, color: CHART_NEUTRAL }] : []),
  ]

  return (
    <ShellChartCard
      className={className}
      title={title}
      subtitle={subtitle}
      table={{
        columns: ["Hạng mục", unit ? `Số lượng (${unit})` : "Số lượng", "Tỉ lệ"],
        rows: [
          ...items.map(
            (p) =>
              [
                p.label,
                formatChartNumber(p.value),
                sum + rest > 0 ? formatPercent((p.value / (sum + rest)) * 100) : "—",
              ] as [string, string, string],
          ),
          [
            overflow > 0 ? "Tổng các phần" : "Tổng",
            formatChartNumber(overflow > 0 ? sum : (total ?? sum)),
            sum + rest > 0 ? "100%" : "—",
          ],
          ...(overflow > 0
            ? [
                [
                  "Tổng đối chiếu",
                  formatChartNumber(total as number),
                  "thấp hơn tổng các phần",
                ] as [string, string, string],
              ]
            : []),
          ...extraRows.map((r) => [r[0], r[1], "—"] as [string, string, string]),
        ],
      }}
      empty={emptyText}
      chartNotice={items.every((p) => !(p.value > 0)) ? emptyText : undefined}
    >
      {items.length > MAX_DONUT_SLICES ? (
        <ShellBarH
          items={withRankColors(items.map(({ label, value }) => ({ label, value })))}
          labelWidth={160}
          formatValue={formatChartNumber}
        />
      ) : (
        <div className="flex justify-center py-1">
          <ShellDonut items={items} size={172} />
        </div>
      )}
    </ShellChartCard>
  )
}

/**
 * Quá NGƯỠNG này thì vẽ thanh ngang một sắc thay vì vành khuyên.
 *
 * Còn một cảnh báo CVD ở cặp màu thứ 5–6, chỉ chạm tới khi vẽ quá 4 series —
 * mà quá 4 thì phải gộp "Khác". Nhưng có những phân chia KHÔNG gộp "Khác"
 * được vì chúng là thang THỨ TỰ — 6 dải tuổi là ví dụ: gộp 2 dải cuối thành "Khác" là phá mất ý nghĩa.
 *
 * Dải teal tuần tự cũng không cứu được: đo trên nền thẻ trắng thì từ bậc 4
 * (`#42b8ac` 2,42) trở đi đã dưới ngưỡng 3:1 cho đồ hoạ.
 *
 * ⇒ Quá 4 phần thì chuyển sang THANH: độ dài mã hoá giá trị (không phụ thuộc
 * phân biệt màu), một sắc nên không có cặp CVD nào, và cột "Tỉ lệ" trong bảng
 * vẫn giữ nguyên ý nghĩa "phần của một tổng". Đặt ngưỡng trong primitive để
 * không ai phải nhớ luật này ở từng màn.
 */
const MAX_DONUT_SLICES = 4

/**
 * Thẻ "vài chỉ số SO SÁNH" — thanh ngang + bảng.
 *
 * Dùng khi các số cùng đơn vị nhưng KHÔNG phải phần của một tổng (vd tổng
 * quản lý vs đang chạy vs bị khoá).
 */
export function ShellCompareCard({
  title,
  subtitle,
  items,
  formatValue = formatChartNumber,
  extraRows = [],
  emptyText = "Chưa có dữ liệu",
  labelWidth = 148,
  className,
}: {
  title: string
  subtitle?: string
  items: { label: string; value: number; note?: string }[]
  formatValue?: (v: number) => string
  /**
   * Số KHÁC ĐƠN VỊ với `items` (vd số đơn bên cạnh hai khoản tiền) — vào
   * bảng chứ KHÔNG vào thanh, vì chung một trục là so tiền với số đếm.
   */
  extraRows?: [string, string][]
  emptyText?: string
  labelWidth?: number
  className?: string
}) {
  return (
    <ShellChartCard
      className={className}
      title={title}
      subtitle={subtitle}
      table={{
        columns: ["Chỉ số", "Giá trị"],
        rows: [...items.map((i) => [i.label, formatValue(i.value)]), ...extraRows],
      }}
      empty={emptyText}
      chartNotice={items.every((i) => !(i.value > 0)) ? emptyText : undefined}
    >
      <ShellBarH
        items={withRankColors(items)}
        labelWidth={labelWidth}
        formatValue={formatValue}
      />
    </ShellChartCard>
  )
}

/**
 * Thẻ "một tỉ lệ phần trăm" — vòng + 2 số gốc sinh ra nó.
 *
 * `denominator === 0` ⇒ tỉ lệ CHƯA XÁC ĐỊNH, vòng in "—" chứ không in 0%
 *. Caption luôn mang 2 số gốc: 55% của 20 và của 20.000 là hai câu
 * chuyện khác nhau.
 */
export function ShellRateCard({
  title,
  subtitle,
  label,
  numerator,
  denominator,
  unitText,
  extraRows = [],
  color,
  className,
}: {
  title: string
  subtitle?: string
  label: string
  numerator: number
  denominator: number
  unitText: string
  extraRows?: [string, string][]
  color?: string
  className?: string
}) {
  const rate = denominator > 0 ? (numerator / denominator) * 100 : Number.NaN
  /* Tử LỚN HƠN mẫu ⇒ `ShellRadial` kẹp cung ở 100% nhưng CON SỐ in ra vẫn là
   * "250%". Cung kẹp làm hình trông như đã hoàn thành trọn vẹn, trong khi con
   * số nói điều khác — người đọc tin cái nào? Thường đây là dấu hiệu mẫu số
   * KHÔNG phải quần thể của tử (2 vị từ độc lập, 2 cửa sổ thời gian, hoặc 2
   * đơn vị). Không tự sửa số, nhưng phải nói ra để không ai đọc nhầm thành
   * "tỉ lệ hoàn thành". */
  const exceedsWhole = denominator > 0 && numerator > denominator
  return (
    <ShellChartCard
      className={className}
      title={title}
      subtitle={subtitle}
      table={{
        columns: ["Chỉ số", "Giá trị"],
        rows: [
          [`Tổng ${unitText}`, formatChartNumber(denominator)],
          [label, formatChartNumber(numerator)],
          ["Tỉ lệ", denominator > 0 ? formatPercent(rate) : "—"],
          ...(exceedsWhole
            ? ([
                [
                  "⚠ Lưu ý",
                  `"${label}" nhiều hơn tổng ${unitText} — vòng bên cạnh bị kẹp ở 100%`,
                ],
              ] as [string, string][])
            : []),
          ...extraRows,
        ],
      }}
    >
      <div className="flex h-full items-center justify-center py-2">
        <ShellRadial
          value={rate}
          label={label}
          color={color}
          size={168}
          caption={
            denominator > 0
              ? `${formatChartNumber(numerator)} / ${formatChartNumber(denominator)} ${unitText}`
              : `Chưa có ${unitText} nào`
          }
        />
      </div>
    </ShellChartCard>
  )
}

/**
 * Thẻ "phễu các chặng LỒNG NHAU" — thanh ngang giảm dần + % so chặng đầu.
 *
 * ⚠️ Chỉ dùng khi chặng sau THẬT SỰ là tập con của chặng trước. Các số rời
 * nhau thì dùng `ShellCompareCard`.
 */
export function ShellFunnelCard({
  title,
  subtitle,
  steps,
  unitText,
  extraRows = [],
  emptyText = "Chưa có dữ liệu",
  className,
}: {
  title: string
  subtitle?: string
  steps: { label: string; value: number }[]
  unitText: string
  extraRows?: [string, string][]
  emptyText?: string
  className?: string
}) {
  const first = steps[0]?.value ?? 0
  return (
    <ShellChartCard
      className={className}
      title={title}
      subtitle={subtitle}
      table={{
        columns: ["Chặng", unitText, "Còn lại so với chặng đầu"],
        rows: [
          ...steps.map(
            (s) =>
              [
                s.label,
                formatChartNumber(s.value),
                // Guard `first > 0` ở đây là PHÒNG THỦ THỨ HAI, không phải
                // thứ duy nhất: `formatPercent` vốn đã trả "—" cho cả NaN
                // (0/0) lẫn Infinity (n/0). Giữ vì nó nói rõ ý định ngay tại
                // chỗ đọc — nhưng đừng tưởng bỏ đi là sinh bug: mutation-test
                // cho thấy đây là đột biến TƯƠNG ĐƯƠNG, không test nào bắt
                // được và cũng không cần bắt.
                first > 0 ? formatPercent((s.value / first) * 100) : "—",
              ] as [string, string, string],
          ),
          ...extraRows.map((r) => [r[0], r[1], "—"] as [string, string, string]),
        ],
      }}
      empty={emptyText}
      /* 🔴 `first === 0` KHÔNG đồng nghĩa "chưa có gì". Ca thật:
         chặng đầu (chưa chia) trôi hết về 0 trong khi chặng sau vẫn giữ 40 —
         in "chưa có dữ liệu" lúc đó là GIẤU 40 bản ghi có thật sau một câu
         phủ định. Chỉ ẩn hình khi MỌI chặng đều bằng 0 (lúc đó thanh mới thật
         sự không nói được gì). */
      chartNotice={steps.every((s) => !(s.value > 0)) ? emptyText : undefined}
    >
      <ShellBarH
        items={funnelColors(steps)}
        labelWidth={160}
        formatValue={formatChartNumber}
      />
    </ShellChartCard>
  )
}

/**
 * Màu cho phễu — dải teal tuần tự CHỈ khi ≤ 3 chặng.
 *
 * Đo trên nền thẻ trắng (hex thật trong `app-tokens.css`, công thức WCAG):
 *   chặng 1 `#065c57` 7,85 · chặng 2 `#0a7f78` 4,86 · chặng 3 `#0e9c93` 3,39
 *   chặng 4 `#42b8ac` 2,42 · 5 `#77cec4` 1,84 · 6 `#a9e0da` 1,46 · 7 `#d2efeb` 1,21
 *
 * Tức là từ chặng thứ TƯ trở đi thanh tụt dưới ngưỡng 3:1 cho đồ hoạ — ai nhìn
 * màn hình chói hoặc mắt kém sẽ không thấy thanh đâu nữa. Đây đúng quyết định
 * đã chốt ở phễu pipeline: độ DÀI thanh đã mang thứ tự rồi, không cần
 * màu nhạt dần trả giá bằng việc biến mất.
 */
function funnelColors(steps: { label: string; value: number }[]) {
  const MAX_SEQ_STEPS = 3
  return steps.length <= MAX_SEQ_STEPS
    ? withSequentialColors(steps)
    : withRankColors(steps)
}
