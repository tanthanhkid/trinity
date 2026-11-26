import { dayBucket, evaluateGraphWindow, graphGuardConfig, hourBucket, type GraphWindowEvent } from './channel-guard.service';
import { isGraphAppLevelLimit, isGraphBlockOutcome } from './graph-observer';

const cfg = graphGuardConfig({});
const NOW = Date.UTC(2026, 10, 26, 3, 30, 0);
const ev = (minAgo: number, code: number | null, block = true): GraphWindowEvent => ({ t: NOW - minAgo * 60_000, block, code });

describe('evaluateGraphWindow', () => {
  it('hai lần #368 trong cửa sổ ⇒ tạm dừng ngay, kể cả ít lời gọi', () => {
    const v = evaluateGraphWindow([ev(5, 368), ev(1, 368)], NOW, cfg);
    expect(v.trip).toBe(true);
    expect(v.reason).toMatch(/#368/);
    expect(v.codes).toEqual({ '368': 2 });
  });

  it('một lần #368 chưa đủ', () => {
    expect(evaluateGraphWindow([ev(1, 368)], NOW, cfg).trip).toBe(false);
  });

  it('tỉ lệ lỗi chặn ≥ 30% với đủ số lỗi và số lời gọi ⇒ tạm dừng', () => {
    const blocks = Array.from({ length: 10 }, (_, i) => ev(i + 1, i % 2 ? 17 : 551));
    const oks = Array.from({ length: 20 }, (_, i) => ev(i + 1, null, false));
    const v = evaluateGraphWindow([...blocks, ...oks], NOW, cfg);
    expect(v.trip).toBe(true);
    expect(v).toMatchObject({ calls: 30, blocks: 10 });
  });

  it('tỉ lệ thấp hoặc quá ít lỗi thì không tạm dừng', () => {
    const oks = Array.from({ length: 80 }, (_, i) => ev(i % 50, null, false));
    const few = Array.from({ length: 9 }, (_, i) => ev(i + 1, 4));
    expect(evaluateGraphWindow([...few, ...oks], NOW, cfg).trip).toBe(false);
    const rare = Array.from({ length: 10 }, (_, i) => ev(i + 1, 4));
    const many = Array.from({ length: 100 }, () => ev(2, null, false));
    expect(evaluateGraphWindow([...rare, ...many], NOW, cfg).trip).toBe(false);
  });

  it('lời gọi ngoài cửa sổ 60 phút không tính', () => {
    expect(evaluateGraphWindow([ev(90, 368), ev(80, 368)], NOW, cfg).trip).toBe(false);
  });

  it('ngưỡng đọc từ biến môi trường, giá trị rác rơi về mặc định', () => {
    expect(graphGuardConfig({ CHANNEL_GUARD_PAUSE_HOURS: '2', CHANNEL_GUARD_MAX_BLOCK_RATE: 'x' })).toMatchObject({ pauseMs: 2 * 3_600_000, maxBlockRate: 0.3 });
  });
});

describe('isGraphBlockOutcome / isGraphAppLevelLimit', () => {
  const send = true;
  it.each([
    [{ httpStatus: 400, code: 368, subcode: null, send }, true],
    [{ httpStatus: 400, code: 551, subcode: null, send }, true],
    [{ httpStatus: 400, code: 17, subcode: null, send }, true],
    [{ httpStatus: 400, code: 32, subcode: null, send }, true],
    // lời gọi đọc không tính
    [{ httpStatus: 400, code: 368, subcode: null, send: false }, false],
    [{ httpStatus: 403, code: 10, subcode: null, send: false }, false],
    // quyền thường gặp, ngoài cửa sổ 24h, token
    [{ httpStatus: 400, code: 10, subcode: null, send }, false],
    [{ httpStatus: 400, code: 200, subcode: null, send }, false],
    [{ httpStatus: 400, code: 10, subcode: 2018278, send }, false],
    [{ httpStatus: 400, code: 551, subcode: 2018278, send }, false],
    [{ httpStatus: 400, code: 190, subcode: null, send }, false],
    // cấp app: không tính theo công ty
    [{ httpStatus: 400, code: 4, subcode: null, send }, false],
    [{ httpStatus: 400, code: 613, subcode: null, send }, false],
    [{ httpStatus: 429, code: null, subcode: null, send }, false],
  ])('%j ⇒ block %s', (o, want) => expect(isGraphBlockOutcome(o)).toBe(want));

  it.each([
    [{ httpStatus: 400, code: 4 }, true],
    [{ httpStatus: 400, code: 613 }, true],
    [{ httpStatus: 429, code: null }, true],
    [{ httpStatus: 400, code: 17 }, false],
    [{ httpStatus: 400, code: 368 }, false],
  ])('%j ⇒ app-level %s', (o, want) => expect(isGraphAppLevelLimit(o)).toBe(want));
});

describe('khung đếm', () => {
  it('ngày tính theo giờ Việt Nam (đổi ngày lúc 17:00 UTC)', () => {
    expect(dayBucket(Date.UTC(2026, 10, 26, 16, 59)).toISOString()).toBe('2026-11-25T17:00:00.000Z');
    expect(dayBucket(Date.UTC(2026, 10, 26, 17, 0)).toISOString()).toBe('2026-11-26T17:00:00.000Z');
  });
  it('giờ cắt đầu giờ', () => {
    expect(hourBucket(NOW).toISOString()).toBe('2026-11-26T03:00:00.000Z');
  });
});
