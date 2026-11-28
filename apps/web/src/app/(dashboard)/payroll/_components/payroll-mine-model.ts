// Dữ liệu hiển thị của «Phiếu của tôi» — thuần, dựng từ một dòng `GET /payslips/me`.
import type { PayslipRow } from "./payroll-payslips-shared"

export interface MineRow { label: string; sub: string; amount: string }
export interface MineGroup { key: "inc" | "ded"; title: string; sign: "+" | "-"; sum: string; rows: MineRow[] }

const vn = (v: number | string | null | undefined) => Number(v ?? 0).toLocaleString("vi-VN")

export function buildMineGroups(row: PayslipRow): MineGroup[] {
  const std = row.standard_working_days || 24
  const inc: MineRow[] = [
    {
      label: "Lương theo công",
      sub: row.working_days === null ? "Đủ công" : `${row.working_days} trên ${std} ngày công`,
      amount: vn(row.base_salary_actual),
    },
  ]
  const add = (label: string, sub: string, v: string | null | undefined) => {
    if (Number(v ?? 0) > 0) inc.push({ label, sub, amount: vn(v) })
  }
  add("Lương học việc", "Theo ngày học việc", row.training_salary)
  add("Phụ cấp học việc", "Theo quy định", row.probation_allowance)
  add("Thưởng doanh số", "Theo doanh số tháng", row.bonus_sales_personal)
  add("Thưởng mốc", "Đạt mốc trong tháng", row.bonus_milestone)
  add("Thưởng team", "Theo kết quả của team", row.bonus_cskh_team)
  add("Thưởng giới thiệu", "Giới thiệu nhân sự hoặc khách mới", row.bonus_referral)
  add("Thưởng lễ", "Lễ, Tết", row.holiday_bonus)

  const ded: MineRow[] = []
  const ins = Number(row.insurance_total ?? 0)
  if (ins > 0) {
    ded.push({
      label: "Bảo hiểm xã hội, y tế, thất nghiệp",
      sub: row.insurance_json?.length ? row.insurance_json.map((i) => `${i.rate}%`).join(" + ") : "Phần người lao động đóng",
      amount: vn(ins),
    })
  }
  ded.push({
    label: "Thuế thu nhập cá nhân",
    sub: Number(row.tax_total ?? 0) > 0 ? "Phần vượt mức giảm trừ" : "Chưa tới mức chịu thuế",
    amount: vn(row.tax_total),
  })
  for (const c of row.components_json ?? []) {
    if (c.component_type === "deduction" && Number(c.amount) > 0) ded.push({ label: c.name, sub: "Khấu trừ theo quy định", amount: vn(c.amount) })
  }
  if (Number(row.advances ?? 0) > 0) ded.push({ label: "Tạm ứng đã nhận", sub: "Các khoản đã chi lĩnh trước", amount: vn(row.advances) })

  return [
    { key: "inc", title: "Thu nhập", sign: "+", sum: vn(row.tong_luong), rows: inc },
    { key: "ded", title: "Khấu trừ", sign: "-", sum: vn(row.tong_giam_tru), rows: ded },
  ]
}

export function mineStatusHint(row: PayslipRow): string {
  if (row.status === "paid") return "Kỳ lương đã trả."
  if (row.status === "approved") return "Phiếu đã được duyệt."
  if (row.status === "pending_tl" || row.status === "pending_accountant") return "Phiếu đang chờ duyệt. Số có thể đổi trước khi duyệt."
  return "Kế toán đang soát. Số có thể đổi trước khi duyệt."
}
