import { createSocialPostAction, parseScheduledAt, vnWhen } from '../action-social-tools';

describe('hẹn giờ đăng bài qua AI', () => {
  it('thiếu múi giờ ⇒ hiểu là giờ Việt Nam', () => {
    expect(parseScheduledAt('2026-10-20T09:00')).toBe('2026-10-20T02:00:00.000Z');
    expect(parseScheduledAt('2026-10-20 09:00')).toBe('2026-10-20T02:00:00.000Z');
    expect(parseScheduledAt('2026-10-20T09:00:30')).toBe('2026-10-20T02:00:30.000Z');
  });
  it('có múi giờ ⇒ giữ nguyên', () => {
    expect(parseScheduledAt('2026-10-20T09:00:00Z')).toBe('2026-10-20T09:00:00.000Z');
    expect(parseScheduledAt('2026-10-20T09:00+08:00')).toBe('2026-10-20T01:00:00.000Z');
  });
  it('trống ⇒ đăng ngay; sai dạng ⇒ lỗi dễ hiểu', () => {
    expect(parseScheduledAt(undefined)).toBeNull();
    expect(parseScheduledAt('  ')).toBeNull();
    expect(() => parseScheduledAt('thứ hai tuần sau')).toThrow(/YYYY-MM-DDTHH:mm/);
  });
  it('hiện giờ theo giờ Việt Nam', () => {
    expect(vnWhen(new Date('2026-10-20T02:00:00Z'))).toBe('09:00 Thứ Ba 20/10/2026 (giờ Việt Nam)');
    expect(vnWhen(new Date('2026-10-24T18:30:00Z'))).toBe('01:30 Chủ nhật 25/10/2026 (giờ Việt Nam)');
  });
  it('mô tả tool có hướng dẫn hẹn giờ', () => {
    expect(createSocialPostAction.description).toMatch(/scheduled_at/);
  });
});
