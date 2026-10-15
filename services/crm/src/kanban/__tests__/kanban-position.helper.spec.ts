import {
  computeAppendPosition,
  computeBetweenPosition,
  renormalizedPositions,
} from '../common/kanban-position.helper';
import { KANBAN_POSITION_GAP } from '../common/kanban.constants';

describe('kanban-position.helper — fractional indexing (§Kỹ thuật)', () => {
  it('computeAppendPosition: danh sách rỗng => GAP; có phần tử => +GAP', () => {
    expect(computeAppendPosition(null)).toBe(KANBAN_POSITION_GAP);
    expect(computeAppendPosition(1000)).toBe(1000 + KANBAN_POSITION_GAP);
  });

  it('computeBetweenPosition: cả 2 đầu null => GAP mặc định (cột rỗng)', () => {
    expect(computeBetweenPosition(null, null)).toBe(KANBAN_POSITION_GAP);
  });

  it('computeBetweenPosition: chèn ĐẦU danh sách (before=null)', () => {
    const pos = computeBetweenPosition(null, 1000);
    expect(pos).toBeLessThan(1000);
    expect(pos).toBeGreaterThan(0);
  });

  it('computeBetweenPosition: chèn CUỐI danh sách (after=null)', () => {
    expect(computeBetweenPosition(1000, null)).toBe(1000 + KANBAN_POSITION_GAP);
  });

  it('computeBetweenPosition: chèn GIỮA 2 phần tử — nằm đúng giữa', () => {
    const pos = computeBetweenPosition(1000, 2000);
    expect(pos).toBe(1500);
  });

  it('computeBetweenPosition: khoảng cách cạn (gap quá nhỏ) => trả null, báo hiệu renormalize', () => {
    expect(computeBetweenPosition(1000, 1000 + 1e-9)).toBeNull();
  });

  it('chèn LẶP NHIỀU LẦN vào cùng 1 khe không làm mất thứ tự cho tới khi cạn gap', () => {
    let before = 1000;
    let after = 2000;
    let steps = 0;
    while (steps < 30) {
      const mid = computeBetweenPosition(before, after);
      if (mid === null) break;
      after = mid; // luôn chèn ngay trước "after" cũ
      steps += 1;
    }
    // double precision đủ chỗ cho hàng chục lần chèn liên tiếp trước khi cạn
    expect(steps).toBeGreaterThan(10);
  });

  it('renormalizedPositions: N phần tử cách đều GAP, tăng dần', () => {
    const positions = renormalizedPositions(5);
    expect(positions).toEqual([1024, 2048, 3072, 4096, 5120]);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  it('renormalizedPositions(0) => mảng rỗng', () => {
    expect(renormalizedPositions(0)).toEqual([]);
  });
});
