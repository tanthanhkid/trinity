import {
  computeContractStatus,
  EXPIRY_WARNING_DAYS,
} from '../contract-status.helper';

describe('computeContractStatus', () => {
  const now = new Date('2026-06-13T00:00:00+07:00');
  const daysFromNow = (d: number) =>
    new Date(now.getTime() + d * 24 * 60 * 60 * 1000);

  it('đã chấm dứt → terminated, days null (ưu tiên trên mọi end_date)', () => {
    expect(computeContractStatus(daysFromNow(100), true, now)).toEqual({
      status: 'terminated',
      days_remaining: null,
    });
    // chấm dứt thắng cả khi đã quá hạn
    expect(computeContractStatus(daysFromNow(-50), true, now)).toEqual({
      status: 'terminated',
      days_remaining: null,
    });
  });

  it('end_date null (không thời hạn) → active, days null', () => {
    expect(computeContractStatus(null, false, now)).toEqual({
      status: 'active',
      days_remaining: null,
    });
  });

  it('còn > 30 ngày → active', () => {
    const r = computeContractStatus(daysFromNow(60), false, now);
    expect(r.status).toBe('active');
    expect(r.days_remaining).toBe(60);
  });

  it('còn đúng 30 ngày → expiring (biên ngưỡng)', () => {
    const r = computeContractStatus(daysFromNow(EXPIRY_WARNING_DAYS), false, now);
    expect(r.status).toBe('expiring');
    expect(r.days_remaining).toBe(30);
  });

  it('còn 1 ngày → expiring', () => {
    expect(computeContractStatus(daysFromNow(1), false, now).status).toBe(
      'expiring',
    );
  });

  it('quá hạn (days < 0) → expired, days âm', () => {
    const r = computeContractStatus(daysFromNow(-5), false, now);
    expect(r.status).toBe('expired');
    expect(r.days_remaining).toBeLessThan(0);
  });

  it('vừa hết hạn trong vòng 24h → expired, không lọt expiring', () => {
    const r = computeContractStatus(new Date(now.getTime() - 8 * 3600 * 1000), false, now);
    expect(r.status).toBe('expired');
    expect(r.days_remaining).toBeLessThan(0);
  });
});
