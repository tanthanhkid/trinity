import {
  cellDisplayText,
  computeNotes,
  daysInMonthFromDateFrom,
  formatHm,
} from '../attendance-matrix.helper';

describe('attendance-matrix.helper', () => {
  describe('formatHm', () => {
    it('null → ""', () => expect(formatHm(null)).toBe(''));
    it('8 → "8:00"', () => expect(formatHm(8)).toBe('8:00'));
    it('8.5 → "8:30"', () => expect(formatHm(8.5)).toBe('8:30'));
    it('0 → "0:00"', () => expect(formatHm(0)).toBe('0:00'));
    it('4.25 → "4:15"', () => expect(formatHm(4.25)).toBe('4:15'));
    it('0.5 → "0:30"', () => expect(formatHm(0.5)).toBe('0:30'));
  });

  describe('cellDisplayText', () => {
    it('present → "8:00"', () => expect(cellDisplayText('present', 8)).toBe('8:00'));
    it('leave → "8:00"', () => expect(cellDisplayText('leave', null)).toBe('8:00'));
    it('maternity → "8:00"', () => expect(cellDisplayText('maternity', null)).toBe('8:00'));
    it('half_day(4.5) → "4:30"', () => expect(cellDisplayText('half_day', 4.5)).toBe('4:30'));
    it('insufficient(2) → "2:00"', () => expect(cellDisplayText('insufficient', 2)).toBe('2:00'));
    it('review(0.5) → "0:30"', () => expect(cellDisplayText('review', 0.5)).toBe('0:30'));
    it('incomplete → "???"', () => expect(cellDisplayText('incomplete', null)).toBe('???'));
    it('unknown → "·"', () => expect(cellDisplayText('unknown', null)).toBe('·'));
    it('"" → "·"', () => expect(cellDisplayText('', null)).toBe('·'));
  });

  describe('computeNotes', () => {
    it('tất cả 0 → ""', () => {
      expect(
        computeNotes({ incomplete_days: 0, half_days: 0, insufficient_days: 0, late_days: 0 }),
      ).toBe('');
    });

    it('chỉ incomplete → đúng', () => {
      expect(
        computeNotes({ incomplete_days: 2, half_days: 0, insufficient_days: 0, late_days: 0 }),
      ).toBe('Thiếu vào/ra: 2 ngày');
    });

    it('chỉ late → đúng', () => {
      expect(
        computeNotes({ incomplete_days: 0, half_days: 0, insufficient_days: 0, late_days: 3 }),
      ).toBe('Đi muộn: 3 lần');
    });

    it('half_days + insufficient gộp thành "Chưa đủ công"', () => {
      expect(
        computeNotes({ incomplete_days: 0, half_days: 2, insufficient_days: 1, late_days: 0 }),
      ).toBe('Chưa đủ công: 3 ngày');
    });

    it('mix → ghép " · " đúng thứ tự', () => {
      const result = computeNotes({
        incomplete_days: 1,
        half_days: 2,
        insufficient_days: 0,
        late_days: 4,
      });
      expect(result).toBe('Thiếu vào/ra: 1 ngày · Chưa đủ công: 2 ngày · Đi muộn: 4 lần');
    });

    it('chỉ insufficient_days → "Chưa đủ công"', () => {
      expect(
        computeNotes({ incomplete_days: 0, half_days: 0, insufficient_days: 1, late_days: 0 }),
      ).toBe('Chưa đủ công: 1 ngày');
    });
  });

  describe('daysInMonthFromDateFrom', () => {
    it('"2026-06-01" → 30', () => expect(daysInMonthFromDateFrom('2026-06-01')).toBe(30));
    it('"2026-02-01" → 28 (2026 không nhuận)', () =>
      expect(daysInMonthFromDateFrom('2026-02-01')).toBe(28));
    it('"2026-01-15" → 31 (tính theo tháng date_from)', () =>
      expect(daysInMonthFromDateFrom('2026-01-15')).toBe(31));
    it('"2024-02-01" → 29 (2024 nhuận)', () =>
      expect(daysInMonthFromDateFrom('2024-02-01')).toBe(29));
    it('"2026-12-01" → 31', () => expect(daysInMonthFromDateFrom('2026-12-01')).toBe(31));
  });
});
