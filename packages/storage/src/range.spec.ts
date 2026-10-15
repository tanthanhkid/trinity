import { parseRange } from './range';

describe('parseRange', () => {
  const size = 1000;

  it('không có range → null (full object)', () => {
    expect(parseRange(undefined, size)).toBeNull();
  });

  it('bytes=0-499 → {start:0,end:499}', () => {
    expect(parseRange('bytes=0-499', size)).toEqual({ start: 0, end: 499 });
  });

  it('bytes=500- (tới hết file) → {start:500,end:999}', () => {
    expect(parseRange('bytes=500-', size)).toEqual({ start: 500, end: 999 });
  });

  it('bytes=-200 (suffix 200 byte cuối) → {start:800,end:999}', () => {
    expect(parseRange('bytes=-200', size)).toEqual({ start: 800, end: 999 });
  });

  it('end vượt size → clamp về size-1', () => {
    expect(parseRange('bytes=900-9999', size)).toEqual({ start: 900, end: 999 });
  });

  it('start > end → null', () => {
    expect(parseRange('bytes=500-100', size)).toBeNull();
  });

  it('start âm/không hợp lệ → null', () => {
    expect(parseRange('bytes=-1-100', size)).toBeNull();
  });

  it('multi-range (không hỗ trợ) → null', () => {
    expect(parseRange('bytes=0-99,200-299', size)).toBeNull();
  });

  it('cú pháp lạ → null', () => {
    expect(parseRange('items=0-99', size)).toBeNull();
  });

  it('bytes=- (rỗng cả 2 đầu) → null', () => {
    expect(parseRange('bytes=-', size)).toBeNull();
  });

  it('size=0 → null', () => {
    expect(parseRange('bytes=0-10', 0)).toBeNull();
  });
});
