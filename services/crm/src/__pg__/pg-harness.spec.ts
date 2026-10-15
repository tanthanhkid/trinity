import { isLocalDbUrl } from './pg-harness';

describe('isLocalDbUrl — chỉ cho TRUNCATE trên DB cục bộ/CI', () => {
  it('nhận localhost / 127.0.0.1', () => {
    expect(isLocalDbUrl('postgresql://test:test@localhost:5432/t')).toBe(true);
    expect(isLocalDbUrl('postgresql://test@127.0.0.1:55432/t')).toBe(true);
  });
  it('từ chối DB từ xa, kể cả khi tên người dùng là "postgres" hoặc "localhost"', () => {
    expect(isLocalDbUrl('postgresql://postgres:secret@db.example.com/prod')).toBe(false);
    expect(isLocalDbUrl('postgresql://localhost:pw@10.0.0.5:5432/prod')).toBe(false);
    expect(isLocalDbUrl('rác')).toBe(false);
  });
});
