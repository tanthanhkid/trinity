import { resolveSafeKey } from './path-safety';
import { StorageInvalidKeyError } from './types';

describe('resolveSafeKey', () => {
  const root = '/var/lib/trinity/storage';

  it('key hợp lệ → path nằm trong root', () => {
    expect(resolveSafeKey(root, 'documents/0912345678/attachments/1_a.jpg')).toBe(
      '/var/lib/trinity/storage/documents/0912345678/attachments/1_a.jpg',
    );
  });

  it('key rỗng → throw', () => {
    expect(() => resolveSafeKey(root, '')).toThrow(StorageInvalidKeyError);
  });

  it('null byte → throw', () => {
    expect(() => resolveSafeKey(root, 'a\0b')).toThrow(StorageInvalidKeyError);
  });

  it('backslash (Windows-style traversal) → throw', () => {
    expect(() => resolveSafeKey(root, '..\\..\\etc\\passwd')).toThrow(
      StorageInvalidKeyError,
    );
  });

  it('đường dẫn tuyệt đối POSIX → throw', () => {
    expect(() => resolveSafeKey(root, '/etc/passwd')).toThrow(StorageInvalidKeyError);
  });

  it('ổ đĩa Windows → throw', () => {
    expect(() => resolveSafeKey(root, 'C:/Windows/System32')).toThrow(
      StorageInvalidKeyError,
    );
  });

  it('.. đơn thuần → throw', () => {
    expect(() => resolveSafeKey(root, '..')).toThrow(StorageInvalidKeyError);
  });

  it('traversal đơn giản ../../etc/passwd → throw', () => {
    expect(() => resolveSafeKey(root, '../../etc/passwd')).toThrow(
      StorageInvalidKeyError,
    );
  });

  it('traversal lồng trong key hợp lệ (documents/../../etc/passwd) → throw', () => {
    expect(() => resolveSafeKey(root, 'documents/../../etc/passwd')).toThrow(
      StorageInvalidKeyError,
    );
  });

  it('traversal chỉ vừa đủ thoát 1 cấp rồi quay lại vẫn hợp lệ (documents/../notes/1/x.jpg)', () => {
    // documents/../notes/1/x.jpg normalize còn "notes/1/x.jpg" — KHÔNG thoát
    // khỏi root vì chỉ đi lùi lại đúng 1 cấp rồi tiến tiếp bên trong root.
    expect(resolveSafeKey(root, 'documents/../notes/1/x.jpg')).toBe(
      '/var/lib/trinity/storage/notes/1/x.jpg',
    );
  });

  it('tên file trông giống traversal nhưng không có dấu / vẫn AN TOÀN (notes/1/..report.jpg)', () => {
    expect(resolveSafeKey(root, 'notes/1/..report.jpg')).toBe(
      '/var/lib/trinity/storage/notes/1/..report.jpg',
    );
  });

  it('tên file chứa Unicode/khoảng trắng hợp lệ vẫn giữ nguyên', () => {
    expect(resolveSafeKey(root, 'documents/hồ sơ (1).pdf')).toBe(
      '/var/lib/trinity/storage/documents/hồ sơ (1).pdf',
    );
  });
});
