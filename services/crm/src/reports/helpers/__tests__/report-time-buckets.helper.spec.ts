import { parseReportPeriod } from '../report-date-range.helper';
import { pickBucketGranularity, buildReportBuckets } from '../report-time-buckets.helper';

describe('pickBucketGranularity', () => {
  it('kỳ ≤31 ngày → day', () => {
    const p = parseReportPeriod('2026-09-01', '2026-09-30');
    expect(pickBucketGranularity(p.dateFrom, p.dateTo)).toBe('day');
  });

  it('kỳ ≤180 ngày (nhưng >31) → week', () => {
    const p = parseReportPeriod('2026-01-01', '2026-05-01');
    expect(pickBucketGranularity(p.dateFrom, p.dateTo)).toBe('week');
  });

  it('kỳ >180 ngày → month', () => {
    const p = parseReportPeriod('2026-01-01', '2026-12-31');
    expect(pickBucketGranularity(p.dateFrom, p.dateTo)).toBe('month');
  });
});

describe('buildReportBuckets', () => {
  it('kỳ đúng 1 ngày → đúng 1 bucket, khớp biên [dateFrom, dateTo+1ms)', () => {
    const p = parseReportPeriod('2026-09-10', '2026-09-10');
    const buckets = buildReportBuckets(p.dateFrom, p.dateTo, 'day');
    expect(buckets).toHaveLength(1);
    expect(buckets[0].start.getTime()).toBe(p.dateFrom.getTime());
    expect(buckets[0].end.getTime()).toBe(p.dateTo.getTime() + 1);
  });

  it('kỳ 3 ngày, granularity day → đúng 3 bucket liên tiếp, KHÔNG hở/chồng lấn', () => {
    const p = parseReportPeriod('2026-09-01', '2026-09-03');
    const buckets = buildReportBuckets(p.dateFrom, p.dateTo, 'day');
    expect(buckets).toHaveLength(3);
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i].start.getTime()).toBe(buckets[i - 1].end.getTime());
    }
    expect(buckets[0].start.getTime()).toBe(p.dateFrom.getTime());
    expect(buckets[buckets.length - 1].end.getTime()).toBe(p.dateTo.getTime() + 1);
  });

  it('bucket cuối KHÔNG tràn quá dateTo dù granularity week/month lệch biên', () => {
    const p = parseReportPeriod('2026-01-01', '2026-01-10');
    const buckets = buildReportBuckets(p.dateFrom, p.dateTo, 'week');
    const last = buckets[buckets.length - 1];
    expect(last.end.getTime()).toBeLessThanOrEqual(p.dateTo.getTime() + 1);
  });

  it('granularity month — mỗi bucket đúng 1 tháng dương lịch, bucket cuối cắt đúng dateTo', () => {
    const p = parseReportPeriod('2026-01-01', '2026-03-15');
    const buckets = buildReportBuckets(p.dateFrom, p.dateTo, 'month');
    expect(buckets.length).toBeGreaterThanOrEqual(2);
    expect(buckets[buckets.length - 1].end.getTime()).toBe(p.dateTo.getTime() + 1);
  });

  it('granularity month bắt đầu ngày 31 — không tràn tháng ngắn, đủ tháng 02 trên trục', () => {
    const p = parseReportPeriod('2026-01-31', '2026-08-31');
    const buckets = buildReportBuckets(p.dateFrom, p.dateTo, 'month');
    expect(buckets.map((b) => b.label).slice(0, 4)).toEqual(['01/2026', '02/2026', '03/2026', '04/2026']);
    for (let i = 1; i < buckets.length; i++) expect(buckets[i].start.getTime()).toBe(buckets[i - 1].end.getTime());
  });

  it('nhãn "day" dạng dd/MM, nhãn "month" dạng MM/yyyy', () => {
    const p = parseReportPeriod('2026-09-05', '2026-09-05');
    const dayBuckets = buildReportBuckets(p.dateFrom, p.dateTo, 'day');
    expect(dayBuckets[0].label).toBe('05/09');

    const p2 = parseReportPeriod('2026-01-01', '2026-01-01');
    const monthBuckets = buildReportBuckets(p2.dateFrom, p2.dateTo, 'month');
    expect(monthBuckets[0].label).toBe('01/2026');
  });
});
