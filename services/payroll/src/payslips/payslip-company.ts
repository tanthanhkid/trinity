/**
 * Tên công ty in trên phiếu lương (Excel + PDF).
 *
 * Đặt env `PAYROLL_COMPANY_NAME` thành tên PHÁP NHÂN chính xác (loại hình, dấu,
 * viết hoa) — đây là tài liệu phát cho nhân viên nên không hardcode đoán.
 */
export function resolvePayrollCompanyName(): string {
  return process.env.PAYROLL_COMPANY_NAME?.trim() || 'YOUR COMPANY'
}
