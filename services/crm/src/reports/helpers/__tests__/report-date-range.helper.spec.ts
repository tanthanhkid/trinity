import { BadRequestException } from '@nestjs/common';
import {
  parseReportPeriod,
  computePreviousPeriod,
  buildDeltaMetric,
} from '../report-date-range.helper';

describe('parseReportPeriod', () => {
  it('parse đúng biên ngày giờ VN — dateFrom 00:00, dateTo 23:59:59.999 (+07:00)', () => {
    const period = parseReportPeriod('2026-09-01', '2026-09-01');
    expect(period.dateFrom.toISOString()).toBe('2026-08-31T17:00:00.000Z');
    expect(period.dateTo.toISOString()).toBe('2026-09-01T16:59:59.999Z');
  });

  it('thiếu date_from → BadRequestException', () => {
    expect(() => parseReportPeriod(undefined, '2026-09-01')).toThrow(BadRequestException);
  });

  it('thiếu date_to → BadRequestException', () => {
    expect(() => parseReportPeriod('2026-09-01', undefined)).toThrow(BadRequestException);
  });

  it('sai định dạng → BadRequestException', () => {
    expect(() => parseReportPeriod('01/09/2026', '2026-09-01')).toThrow(BadRequestException);
  });

  it('date_from sau date_to → BadRequestException', () => {
    expect(() => parseReportPeriod('2026-09-10', '2026-09-01')).toThrow(BadRequestException);
  });
});

describe('computePreviousPeriod', () => {
  it('kỳ 1 ngày → kỳ trước là đúng 1 ngày liền kề', () => {
    const period = parseReportPeriod('2026-09-10', '2026-09-10');
    const prev = computePreviousPeriod(period);
    expect(prev.dateTo.toISOString()).toBe('2026-09-09T16:59:59.999Z');
    expect(prev.dateFrom.toISOString()).toBe('2026-09-08T17:00:00.000Z');
  });

  it('kỳ 7 ngày → kỳ trước cũng đúng 7 ngày, liền kề, không chồng lấn', () => {
    const period = parseReportPeriod('2026-09-01', '2026-09-07');
    const prev = computePreviousPeriod(period);
    // Kỳ trước kết thúc NGAY TRƯỚC kỳ hiện tại bắt đầu — không có khoảng hở/chồng.
    expect(prev.dateTo.getTime()).toBe(period.dateFrom.getTime() - 1);
    const currentLengthMs = period.dateTo.getTime() - period.dateFrom.getTime();
    const prevLengthMs = prev.dateTo.getTime() - prev.dateFrom.getTime();
    expect(prevLengthMs).toBe(currentLengthMs);
  });
});

describe('buildDeltaMetric', () => {
  it('previous=0 → delta_pct=null (KHÔNG chia 0, null ≠ 0%)', () => {
    expect(buildDeltaMetric(5, 0)).toEqual({
      current: 5,
      previous: 0,
      delta_abs: 5,
      delta_pct: null,
    });
  });

  it('tính đúng % tăng/giảm', () => {
    expect(buildDeltaMetric(15, 10)).toEqual({
      current: 15,
      previous: 10,
      delta_abs: 5,
      delta_pct: 50,
    });
    expect(buildDeltaMetric(5, 10)).toEqual({
      current: 5,
      previous: 10,
      delta_abs: -5,
      delta_pct: -50,
    });
  });

  it('current=previous=0 → delta_pct=null (0/0 không chia)', () => {
    expect(buildDeltaMetric(0, 0).delta_pct).toBeNull();
  });
});
