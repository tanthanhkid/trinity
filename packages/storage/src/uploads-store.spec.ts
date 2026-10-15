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

  it('vercel-blob: ghi vào Blob với key uploads/…; thiếu token → throw', async () => {
    process.env.STORAGE_DRIVER = 'vercel-blob';
    delete process.env.BLOB_READ_WRITE_TOKEN;
    expect(() => createUploadsStore()).toThrow(/BLOB_READ_WRITE_TOKEN/);

    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_s1_x';
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const s = createUploadsStore();
    await s.save('products/p.png', Buffer.from('x'), 'image/png');
    expect(String(fetchMock.mock.calls[0][0])).toContain('pathname=uploads%2Fproducts%2Fp.png');
    fetchMock.mockRestore();
  });
});
