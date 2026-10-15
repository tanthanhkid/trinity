// Ngưỡng cảnh báo "sắp hết hạn" — còn ≤ 30 ngày.
export const EXPIRY_WARNING_DAYS = 30;

// 'no_contract' = nhân viên CHƯA có hợp đồng nào (chỉ dùng cho danh sách theo nhân viên).
// computeContractStatus KHÔNG bao giờ trả 'no_contract' — service tự gán khi không có HĐ.
export type ContractStatus =
  | 'active'
  | 'expiring'
  | 'expired'
  | 'terminated'
  | 'no_contract';

export interface ContractStatusResult {
  status: ContractStatus;
  days_remaining: number | null; // null = không thời hạn / đã chấm dứt
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Tính trạng thái hợp đồng + số ngày còn lại từ end_date + cờ chấm dứt.
 * - is_terminated         → "terminated" (đã chấm dứt), days = null
 * - end_date null         → "active" (không thời hạn), days = null
 * - quá hạn (days < 0)    → "expired", days < 0
 * - còn ≤ 30 ngày         → "expiring"
 * - còn > 30 ngày         → "active"
 */
export function computeContractStatus(
  endDate: Date | null,
  isTerminated: boolean,
  now: Date = new Date(),
): ContractStatusResult {
  if (isTerminated) {
    return { status: 'terminated', days_remaining: null };
  }
  if (!endDate) {
    return { status: 'active', days_remaining: null };
  }
  const diffMs = endDate.getTime() - now.getTime();
  // So mốc thời gian trước khi làm tròn: ceil(-0.33) = -0 sẽ lọt nhánh "expiring".
  if (diffMs < 0) {
    return { status: 'expired', days_remaining: Math.min(-1, Math.ceil(diffMs / MS_PER_DAY)) };
  }
  const days = Math.ceil(diffMs / MS_PER_DAY);
  if (days <= EXPIRY_WARNING_DAYS) {
    return { status: 'expiring', days_remaining: days };
  }
  return { status: 'active', days_remaining: days };
}
