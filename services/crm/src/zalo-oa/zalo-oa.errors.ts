/** Lỗi trả về từ Zalo (`error` ≠ 0) hoặc lỗi mạng khi gọi Zalo. */
export class ZaloApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
  }

  /** Token sai/hết hạn/bị thu hồi ⇒ cần cấp quyền lại hoặc làm mới (-216 access token invalid, -124 hết hạn). */
  get isAuthError(): boolean {
    return this.code === -216 || this.code === -124 || this.code === -118;
  }
}

/** Câu báo khi Zalo đòi OA nâng gói dịch vụ (OA Tier) — gói miễn phí không gửi được tin tư vấn, không đọc được hồ sơ người dùng. */
export const ZALO_TIER_MESSAGE = 'Zalo OA chưa được dùng tính năng này: OA cần nâng gói dịch vụ Zalo OA (Tier). Xem https://zalo.cloud/oa/pricing';

/**
 * Mã lỗi hay gặp → câu tiếng Việt cho người dùng (không lộ nguyên văn lỗi của Zalo).
 * `channel` = API đã gọi: cùng một mã (vd -224) mang nghĩa khác nhau giữa tin tư vấn và ZNS.
 */
export function describeZaloError(e: ZaloApiError, channel: 'consult' | 'zns' = 'zns'): string {
  if (e.isAuthError) return 'Kết nối Zalo OA đã hết hạn hoặc bị thu hồi — cần kết nối lại.';
  if (/tier package|upgrade oa/i.test(e.message)) return ZALO_TIER_MESSAGE;
  if (channel === 'consult' && e.code === -224) return ZALO_TIER_MESSAGE;
  switch (e.code) {
    case -233:
      return 'Người dùng chưa quan tâm OA hoặc đã chặn — không gửi được.';
    case -230:
      return 'Đã quá 48 giờ kể từ tin gần nhất của khách — dùng ZNS thay vì tin tư vấn.';
    case -224:
      return 'Mẫu ZNS không tồn tại hoặc chưa được duyệt.';
    case -225:
      return 'Số điện thoại không hợp lệ hoặc không dùng Zalo.';
    case -226:
      return 'Dữ liệu điền vào mẫu ZNS không hợp lệ.';
    case -223:
      return 'Đã hết hạn mức gửi trong ngày.';
    default:
      return `Zalo từ chối (mã ${e.code}).`;
  }
}
