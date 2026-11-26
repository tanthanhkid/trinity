import { ReadCache, isReadCacheDisabled } from '../read-cache';

describe('ReadCache (thay Redis, G12a)', () => {
  const OLD = process.env.TRINITY_DISABLE_READ_CACHE;
  afterEach(() => {
    if (OLD === undefined) delete process.env.TRINITY_DISABLE_READ_CACHE;
    else process.env.TRINITY_DISABLE_READ_CACHE = OLD;
  });

  it('lưu theo TTL, hết hạn thì trượt', () => {
    const c = new ReadCache();
    c.set('k', 'v', 60, 1_000);
    expect(c.get('k', 60_999)).toBe('v');
    expect(c.get('k', 61_000)).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it('TRINITY_DISABLE_READ_CACHE=1 ⇒ get luôn trượt, set không lưu', () => {
    process.env.TRINITY_DISABLE_READ_CACHE = '1';
    expect(isReadCacheDisabled()).toBe(true);
    const c = new ReadCache();
    c.set('k', 'v', 60);
    expect(c.size).toBe(0);
    expect(c.get('k')).toBeUndefined();
    process.env.TRINITY_DISABLE_READ_CACHE = '0';
    expect(isReadCacheDisabled()).toBe(false);
  });

  it('deletePrefix chỉ xoá đúng tiền tố (cache của công ty khác giữ nguyên)', () => {
    const c = new ReadCache();
    c.set('crm:contacts:count:a', '1', 60);
    c.set('crm:contacts:count:b', '2', 60);
    c.set('c2:crm:contacts:count:a', '3', 60);
    expect(c.deletePrefix('crm:contacts:count:')).toBe(2);
    expect(c.get('c2:crm:contacts:count:a')).toBe('3');
  });

  it('có trần số khoá: đầy thì bỏ khoá cũ nhất', () => {
    const c = new ReadCache();
    for (let i = 0; i <= ReadCache.MAX_KEYS; i++) c.set(`k${i}`, 'x', 60);
    expect(c.size).toBe(ReadCache.MAX_KEYS);
    expect(c.get('k0')).toBeUndefined();
    expect(c.get(`k${ReadCache.MAX_KEYS}`)).toBe('x');
  });

  it('quét khoá hết hạn theo chu kỳ, không quét ở mỗi lần ghi', () => {
    const c = new ReadCache();
    const t0 = 1_000_000;
    c.set('old', 'x', 1, t0);
    c.set('a', 'x', 60, t0 + 1_000); // chưa tới chu kỳ quét (lastSweep = t0): 'old' hết hạn nhưng vẫn nằm trong kho
    expect(c.size).toBe(2);
    c.set('b', 'x', 60, t0 + ReadCache.SWEEP_INTERVAL_MS + 1); // tới chu kỳ: quét
    expect(c.size).toBe(2);
  });
});
