"use client"

import { ShellChartCard } from "@/components/app-shell/charts/chart-card"
import { ShellBarH } from "@/components/app-shell/charts/bar-h"
import { ShellRadial, formatPercent } from "@/components/app-shell/charts/radial"
import { formatChartNumber, withSequentialColors } from "@/components/app-shell/charts/chart-data"

/* =============================================================================
 * Khối BIỂU ĐỒ cho tab Tuyển dụng ("vài số tổng + một phễu").
 * Lưu ý khi thêm phễu hay vòng phần trăm:
 * ba số cùng đơn vị "bản ghi" KHÔNG có nghĩa là chúng lồng nhau. Vẽ phễu hay vòng tỉ lệ trên các số đếm ở những CỬA SỔ THỜI GIAN khác
 * nhau (`created_at` vs các mốc thời gian khác) có thể in ra "233%" hay "769%". Trước khi chọn phễu/vòng, ĐỌC hàm `buildXxxWhere` của BE và
 * kiểm đúng hai điều: (1) cùng một cohort, (2) vị từ của chặng sau là ràng
 * buộc CON của chặng trước. Thiếu một trong hai ⇒ thanh SO SÁNH.
 * ========================================================================== */

// ═══════════════════════════════════════════════════════════════════════════
// Tuyển dụng — phễu 3 chặng + 4 chỉ số phụ
// ═══════════════════════════════════════════════════════════════════════════

export interface RecruitmentOverviewLike {
  positions_posted: number
  candidates_interested: number
  candidates_interviewed: number
  candidates_hired: number
  recruitment_messages: number | null
  recruitment_messages_available: boolean
  cv_received: number | null
  cv_received_available: boolean
}

export function RecruitmentCharts({ data }: { data: RecruitmentOverviewLike }) {
  /* Phễu này hợp lệ ở chỗ quan trọng nhất: CẢ BA chặng cùng một cohort
   * `applied_date ∈ kỳ`, nên mẫu số "chặng đầu" là đúng và tỉ lệ không drift.
   *
   * ⚠️ Nhưng 2 chặng sau là HAI VỊ TỪ ĐỘC LẬP trên cohort đó, không lồng nhau
   * về mặt ràng buộc: `interview_date IS NOT NULL` và `decision = 'hired'`
   * (cột `decision` là `String` tự do, không có khoá nào bắt người được tuyển
   * phải có ngày phỏng vấn). Người tuyển thẳng không qua vòng PV sẽ làm thanh
   * "Đã nhận việc" dài hơn "Đã phỏng vấn" — hình vẫn đọc được, chỉ là không
   * thu hẹp đều. Phụ đề nói thẳng điều đó thay vì hứa "lồng nhau".
   *
   * "Số bài đăng" KHÔNG nằm trong phễu — nó là số VỊ TRÍ, không phải số ứng
   * viên; xếp cùng một phễu là ngụ ý "bài đăng chuyển đổi thành ứng viên", mà
   * một bài đăng có thể ra nhiều ứng viên hoặc không ra ai. */
  const funnel = [
    { label: "Ứng viên quan tâm", value: data.candidates_interested },
    { label: "Đã phỏng vấn", value: data.candidates_interviewed },
    { label: "Đã nhận việc", value: data.candidates_hired },
  ]

  // 2 chỉ số có cờ `*_available`: BE nói rõ "chưa đo được" ≠ "bằng 0".
  const optional = [
    {
      label: "Tin nhắn tuyển dụng",
      value: data.recruitment_messages,
      available: data.recruitment_messages_available,
    },
    { label: "CV nhận được", value: data.cv_received, available: data.cv_received_available },
  ]

  const hireRate =
    data.candidates_interested > 0
      ? (data.candidates_hired / data.candidates_interested) * 100
      : Number.NaN

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <ShellChartCard
        className="lg:col-span-2"
        title="Phễu tuyển dụng"
        subtitle="cùng một nhóm ứng viên nộp trong kỳ — 'đã phỏng vấn' và 'đã nhận việc' là hai mốc độc lập nên số liệu có thể không giảm dần đều. Số bài đăng tính riêng vì là số vị trí tuyển, không phải số ứng viên."
        table={{
          columns: ["Chặng", "Ứng viên", "Còn lại so với chặng đầu"],
          rows: [
            ...funnel.map(
              (f) =>
                [
                  f.label,
                  formatChartNumber(f.value),
                  funnel[0].value > 0
                    ? formatPercent((f.value / funnel[0].value) * 100)
                    : "—",
                ] as [string, string, string],
            ),
            ["Số bài đăng tuyển dụng", formatChartNumber(data.positions_posted), "—"],
            ...optional.map(
              (o) =>
                [
                  o.label,
                  /* 🔴 `available === false` = BE CHƯA ĐO ĐƯỢC, khác 0.
                     Và khác luôn với "—" ở cột bên cạnh, vốn nghĩa là "không
                     áp dụng" (dòng này không thuộc phễu). Cùng một glyph cho
                     hai nghĩa là xoá mất phân biệt; vì vậy ghi hẳn chữ
                     "Chưa có nguồn dữ liệu". */
                  o.available && o.value != null
                    ? formatChartNumber(o.value)
                    : "Chưa có nguồn dữ liệu",
                  "—",
                ] as [string, string, string],
            ),
          ],
        }}
        chartNotice={
          funnel[0].value === 0 ? "Chưa có ứng viên nào trong kỳ" : undefined
        }
      >
        <ShellBarH
          items={withSequentialColors(funnel)}
          labelWidth={148}
          formatValue={formatChartNumber}
        />
      </ShellChartCard>

      <ShellChartCard
        title="Tỷ lệ nhận việc"
        subtitle="trên tổng ứng viên quan tâm trong kỳ"
        table={{
          columns: ["Chỉ số", "Giá trị"],
          rows: [
            ["Ứng viên quan tâm", formatChartNumber(data.candidates_interested)],
            ["Đã nhận việc", formatChartNumber(data.candidates_hired)],
            [
              "Tỷ lệ nhận việc",
              Number.isFinite(hireRate) ? formatPercent(hireRate) : "—",
            ],
          ],
        }}
      >
        <div className="flex h-full items-center justify-center py-2">
          <ShellRadial
            value={hireRate}
            label="Nhận việc"
            size={168}
            caption={
              data.candidates_interested > 0
                ? `${formatChartNumber(data.candidates_hired)} / ${formatChartNumber(data.candidates_interested)} ứng viên`
                : "Chưa có ứng viên nào trong kỳ"
            }
          />
        </div>
      </ShellChartCard>
    </div>
  )
}
