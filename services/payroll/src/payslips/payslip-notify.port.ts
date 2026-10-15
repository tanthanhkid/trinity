/**
 * Cổng (port) thông báo "phiếu lương đã duyệt".
 *
 * Monolith nối cổng này tới `SubscribersService.onPayslipApproved` ngay trong
 * process (do ứng dụng host nối).
 */
export const PAYROLL_PAYSLIP_NOTIFY_PORT = Symbol('PAYROLL_PAYSLIP_NOTIFY_PORT');

export interface PayslipApprovedNotice {
  payslipId: number;
  employeeId: number;
  userId: number;
  month: string;
  baseSalary: number;
  kpiBonus: number;
  totalAmount: number;
  approvedBy: number;
  approvedAt: string;
}

export interface PayslipNotifyPort {
  onPayslipApproved(payload: PayslipApprovedNotice): Promise<void>;
}
