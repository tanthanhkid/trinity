import { KANBAN_POSITION_GAP, KANBAN_POSITION_MIN_GAP } from './kanban.constants';

/**
 * Fractional-indexing thuần cho `position` (Float) — chèn giữa 2 phần tử
 * KHÔNG phải đánh lại số cả cột/board (§Kỹ thuật).
 */

/** Vị trí khi thêm vào CUỐI danh sách (append). `lastPosition=null` = danh sách rỗng. */
export function computeAppendPosition(lastPosition: number | null): number {
  return lastPosition === null ? KANBAN_POSITION_GAP : lastPosition + KANBAN_POSITION_GAP;
}

/**
 * Vị trí khi chèn giữa `before`/`after` (theo thứ tự hiển thị — `before` đứng
 * TRƯỚC `after`). Trả `null` khi khoảng cách còn lại quá nhỏ (double đã cạn độ
 * chính xác thực dụng) — caller PHẢI renormalize cả danh sách rồi gọi lại.
 */
export function computeBetweenPosition(
  before: number | null,
  after: number | null,
): number | null {
  if (before === null && after === null) return KANBAN_POSITION_GAP;
  if (before === null) return (after as number) / 2 > 0 ? (after as number) / 2 : (after as number) - KANBAN_POSITION_GAP;
  if (after === null) return before + KANBAN_POSITION_GAP;
  const gap = after - before;
  if (gap <= KANBAN_POSITION_MIN_GAP) return null;
  return before + gap / 2;
}

/** Renormalize: trả về vị trí MỚI cho `count` phần tử, cách đều `KANBAN_POSITION_GAP`. */
export function renormalizedPositions(count: number): number[] {
  return Array.from({ length: count }, (_, i) => (i + 1) * KANBAN_POSITION_GAP);
}
