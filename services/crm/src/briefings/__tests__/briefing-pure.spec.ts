import { buildBriefingContent, deltaText, formatVnd, shortBody } from '../briefing-text';
import { isSlotDue, slotWindows, vnDayKey } from '../briefing-time';
import { normalizeConfig } from '../briefing-config.service';
import type { BriefingData } from '../briefing.types';

const d = (v: number, p: number) => ({ value: v, prev: p });
const data = (over: Partial<BriefingData['metrics']> = {}, scope: BriefingData['scope'] = 'company'): BriefingData => ({
  slot: 'morning', day: '2026-10-07', periodLabel: 'hôm qua', reminderLabel: 'hôm nay', scope, peopleCount: 5,
  metrics: {
    newContacts: d(12, 9), stageChanges: d(5, 5), dealsCreated: d(3, 4), dealsWon: d(2, 1), wonValue: d(1_250_000_000, 400_000_000),
    dealsLost: d(0, 1), overdueTasks: 4, callbacks: 7, topSellers: [], ...over,
  },
});

describe('định dạng', () => {
  it('formatVnd', () => {
    expect(formatVnd(1_250_000_000)).toBe('1,25 tỷ');
    expect(formatVnd(350_000_000)).toBe('350 triệu');
    expect(formatVnd(850_000)).toBe('850 nghìn');
    expect(formatVnd(0)).toBe('0 đồng');
  });
  it('deltaText', () => {
    expect(deltaText(d(12, 9))).toBe('(tăng 3 so với hôm trước)');
    expect(deltaText(d(1, 3))).toBe('(giảm 2 so với hôm trước)');
    expect(deltaText(d(2, 2))).toBe('(bằng hôm trước)');
  });
});

describe('template bản tin (không AI)', () => {
  it('có số liệu, tiêu đề theo phạm vi', () => {
    const c = buildBriefingContent(data());
    expect(c.title).toBe('Bản tin sáng 07/10 — Toàn công ty');
    expect(c.text).toContain('Khách mới hôm qua: 12 (tăng 3 so với hôm trước).');
    expect(c.text).toContain('Doanh số hôm qua: 1,25 tỷ (tăng 850 triệu so với hôm trước).');
    expect(c.text).toContain('Việc quá hạn: 4.');
  });
  it('có dòng nổi bật khi có dữ liệu', () => {
    const c = buildBriefingContent(data({ topSellers: [{ user_id: 1, name: 'A', won_count: 2, won_value: 5e8 }] }, 'team'));
    expect(c.title).toContain('Nhóm của bạn');
    expect(c.text).toContain('Nổi bật hôm qua: A (2 deal, 500 triệu).');
  });
  it('shortBody: bản mẫu lấy 3 gạch đầu dòng; bản agent viết văn xuôi thì lấy đoạn đầu', () => {
    expect(shortBody(buildBriefingContent(data()))).toContain('Khách mới hôm qua: 12');
    expect(shortBody({ title: 'T', text: 'T\n\nHôm qua đội chốt 2 deal.' })).toBe('Hôm qua đội chốt 2 deal.');
  });
});

describe('thời gian VN', () => {
  it('vnDayKey qua nửa đêm VN', () => {
    expect(vnDayKey(new Date('2026-10-06T17:30:00Z'))).toBe('2026-10-07');
  });
  it('isSlotDue: đúng giờ + bù trong 4 giờ, trước giờ/quá hạn thì không', () => {
    expect(isSlotDue('08:00', new Date('2026-10-07T00:59:00Z'))).toBe(false); // 07:59 VN
    expect(isSlotDue('08:00', new Date('2026-10-07T01:00:00Z'))).toBe(true);
    expect(isSlotDue('08:00', new Date('2026-10-07T04:30:00Z'))).toBe(true); // 11:30 VN
    expect(isSlotDue('08:00', new Date('2026-10-07T06:00:00Z'))).toBe(false); // 13:00 VN
    expect(isSlotDue('xx', new Date())).toBe(false);
  });
  it('cửa sổ sáng = trọn hôm qua; chiều = hôm nay tới giờ, so cùng giờ hôm qua', () => {
    const now = new Date('2026-10-07T01:00:00Z'); // 08:00 VN
    const m = slotWindows('morning', now);
    expect(m.cur.start.toISOString()).toBe('2026-10-05T17:00:00.000Z');
    expect(m.cur.end.toISOString()).toBe('2026-10-06T17:00:00.000Z');
    expect(m.callbacks.start.toISOString()).toBe('2026-10-06T17:00:00.000Z');
    const e = slotWindows('evening', new Date('2026-10-07T10:30:00Z'));
    expect(e.cur.start.toISOString()).toBe('2026-10-06T17:00:00.000Z');
    expect(e.prev.end.toISOString()).toBe('2026-10-06T10:30:00.000Z');
    expect(e.reminderLabel).toBe('ngày mai');
  });
});

describe('cấu hình', () => {
  it('mặc định TẮT, 08:00 và 17:30; giờ rác về mặc định', () => {
    const c = normalizeConfig(undefined);
    expect(c).toEqual({ enabled: false, morning_enabled: true, evening_enabled: true, morning_time: '08:00', evening_time: '17:30', in_app: true });
    expect(normalizeConfig({ morning_time: '25:99', enabled: true })).toMatchObject({ morning_time: '08:00', enabled: true });
  });
});
