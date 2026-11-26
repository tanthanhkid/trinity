import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUploadsStore, uploadsRelPathFromUrl } from './uploads-store';

describe('uploads store', () => {
  const OLD = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD };
  });

  it('uploadsRelPathFromUrl chỉ nhận /uploads/… sạch', () => {
    expect(uploadsRelPathFromUrl('/uploads/avatars/1.jpg')).toBe('avatars/1.jpg');
    expect(uploadsRelPathFromUrl('/uploads/../etc')).toBeNull();
    expect(uploadsRelPathFromUrl('https://x/uploads/a')).toBeNull();
    expect(uploadsRelPathFromUrl(null)).toBeNull();
  });

  it('mặc định: ghi/xoá trên đĩa dưới localRoot (hành vi cũ)', async () => {
    delete process.env.STORAGE_DRIVER;
    const root = mkdtempSync(join(tmpdir(), 'uploads-'));
    try {
      const s = createUploadsStore({ localRoot: root });
      await s.save('avatars/a.jpg', Buffer.from('x'), 'image/jpeg');
      expect(readFileSync(join(root, 'avatars', 'a.jpg')).toString()).toBe('x');
      await expect(s.remove('avatars/a.jpg')).resolves.toBe(true);
      expect(existsSync(join(root, 'avatars', 'a.jpg'))).toBe(false);
      await expect(s.remove('avatars/none.jpg')).resolves.toBe(false);
      await expect(s.save('../evil', Buffer.from('x'), 't')).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cấu hình Blob cũ ⇒ ném lỗi kèm hướng dẫn chuyển dữ liệu, không rơi về đĩa', () => {
    process.env.STORAGE_DRIVER = 'vercel-blob';
    expect(() => createUploadsStore()).toThrow(/không còn được hỗ trợ[\s\S]*UPLOADS_LOCAL_ROOT/);
    delete process.env.STORAGE_DRIVER;
    process.env.BLOB_READ_WRITE_TOKEN = 'x';
    expect(() => createUploadsStore()).toThrow(/BLOB_READ_WRITE_TOKEN/);
    process.env.STORAGE_DRIVER = 'local';
    expect(() => createUploadsStore({ localRoot: '/tmp/x' })).not.toThrow();
  });
});
