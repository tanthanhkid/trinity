import { timingSafeEqual } from 'crypto';

/** Tên header và biến môi trường khoá đổi gói: chỉ Trinity giữ token này. */
export const PLAN_TOKEN_HEADER = 'x-trinity-plan-token';
export const PLAN_TOKEN_ENV = 'TRINITY_PLAN_ADMIN_TOKEN';

/**
 * So khớp token đổi gói, thời gian không phụ thuộc nội dung.
 * Không cấu hình biến môi trường (rỗng) → luôn false: endpoint khoá với mọi người.
 */
export function verifyPlanToken(provided: unknown, expected: string | undefined): boolean {
  if (!expected || typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual đòi cùng độ dài: so sánh với chính nó để không lộ độ dài qua nhánh sớm.
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}
