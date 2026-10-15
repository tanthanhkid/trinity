import { ForbiddenException } from '@nestjs/common';

/**
 * Thu hẹp phạm vi báo cáo Marketing theo tài khoản (nhóm Tuyển dụng) từ owner
 * đã resolve qua `ScopeService.ownerIds(user, 'reports.channels')`.
 *
 * - `owner === 'all'`: không giới hạn; `override` (nếu có) narrow xuống đúng 1
 *   marketing user.
 * - `owner` là mảng (scope own/team/subtree): trả NGUYÊN mảng; nếu client cố
 *   `override` một id NGOÀI owner → 403.
 */
export function resolveMarketingReportScopeIds(
  owner: number[] | 'all',
  override?: number,
): number[] | null {
  if (owner === 'all') {
    return override !== undefined ? [override] : null;
  }
  if (override !== undefined) {
    if (!owner.includes(override)) {
      throw new ForbiddenException('marketing_user_id ngoài phạm vi quyền của bạn');
    }
    return [override];
  }
  return owner;
}
