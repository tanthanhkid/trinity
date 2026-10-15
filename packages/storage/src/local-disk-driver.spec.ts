import { mkdtempSync, rmSync, readdirSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { LocalDiskStorageDriver } from './local-disk-driver';
import { StorageObjectNotFoundError, PresignNotSupportedError } from './types';

function readAll(stream: Readable): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolvePromise(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

describe('LocalDiskStorageDriver', () => {
  let root: string;
  let driver: LocalDiskStorageDriver;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'trinity-storage-test-'));
    driver = new LocalDiskStorageDriver(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('init', () => {
    it('mkdir -p root và kiểm quyền ghi thành công, KHÔNG để lại file test', async () => {
      const nestedRoot = join(root, 'a', 'b', 'c');
      const d = new LocalDiskStorageDriver(nestedRoot);
      await expect(d.init()).resolves.toBeUndefined();
      expect(existsSync(nestedRoot)).toBe(true);
      expect(readdirSync(nestedRoot)).toEqual([]);
    });

    it('LOUD throw khi thư mục root KHÔNG ghi được (permission denied)', async () => {
      const readOnlyParent = join(root, 'readonly-parent');
      const d = new LocalDiskStorageDriver(join(readOnlyParent, 'storage'));
      // mkdtempSync tạo root có quyền ghi mặc định; tạo cha rồi khoá quyền ghi.
      const { mkdirSync } = require('node:fs') as typeof import('node:fs');
      mkdirSync(readOnlyParent);
      chmodSync(readOnlyParent, 0o500); // r-x — không ghi được (bỏ qua nếu chạy bằng root)
      try {
        if (process.getuid && process.getuid() === 0) {
          return; // root bypass permission bits — không kiểm được ca này
        }
        await expect(d.init()).rejects.toThrow(/không ghi được/);
      } finally {
        chmodSync(readOnlyParent, 0o700);
      }
    });
  });

  describe('upload + getObjectStream', () => {
    it('upload Buffer rồi đọc lại đúng nội dung + contentType', async () => {
      const key = 'documents/0912345678/attachments/1_front.jpg';
      await driver.upload(key, Buffer.from('hello world'), 'image/jpeg');
      const obj = await driver.getObjectStream(key);
      expect(obj.contentType).toBe('image/jpeg');
      expect(obj.contentLength).toBe(11);
      await expect(readAll(obj.body)).resolves.toEqual(Buffer.from('hello world'));
    });

    it('upload Readable (stream) — OOM-safe, KHÔNG buffer cả file vào RAM trước ghi', async () => {
      const key = 'newsfeed/videos/1/a.mp4';
      const content = Buffer.from('x'.repeat(5000));
      const source = Readable.from([content.subarray(0, 2500), content.subarray(2500)]);
      await driver.upload(key, source, 'video/mp4', content.length);
      const obj = await driver.getObjectStream(key);
      expect(obj.contentLength).toBe(5000);
      await expect(readAll(obj.body)).resolves.toEqual(content);
    });

    it('không để lại file .tmp- sau khi upload xong (ghi atomic)', async () => {
      await driver.upload('a/b.txt', Buffer.from('x'), 'text/plain');
      const files = readdirSync(join(root, 'a'));
      expect(files.some((f) => f.includes('.tmp-'))).toBe(false);
    });

    it('key không tồn tại → StorageObjectNotFoundError, name="NoSuchKey"', async () => {
      await expect(driver.getObjectStream('khong-ton-tai.jpg')).rejects.toThrow(
        StorageObjectNotFoundError,
      );
      try {
        await driver.getObjectStream('khong-ton-tai.jpg');
        fail('phải throw');
      } catch (err) {
        expect((err as Error).name).toBe('NoSuchKey');
      }
    });

    it('key traversal bị chặn ngay ở upload, KHÔNG ghi ra ngoài root', async () => {
      await expect(
        driver.upload('../../etc/evil.txt', Buffer.from('x'), 'text/plain'),
      ).rejects.toThrow();
    });

    it('ghi đè key cũ bằng nội dung mới → đọc lại ra nội dung MỚI', async () => {
      const key = 'a/b.txt';
      await driver.upload(key, Buffer.from('cu'), 'text/plain');
      await driver.upload(key, Buffer.from('moi'), 'text/plain');
      const obj = await driver.getObjectStream(key);
      await expect(readAll(obj.body)).resolves.toEqual(Buffer.from('moi'));
    });
  });

  describe('getObjectStreamRange', () => {
    const key = 'documents/2026-09-27/voice-note-1.mp3';
    const content = Buffer.from('0123456789');

    beforeEach(async () => {
      await driver.upload(key, content, 'audio/mpeg');
    });

    it('không có range → 200 full object', async () => {
      const r = await driver.getObjectStreamRange(key);
      expect(r.statusCode).toBe(200);
      expect(r.contentLength).toBe(10);
      await expect(readAll(r.body)).resolves.toEqual(content);
    });

    it('range hợp lệ → 206 + đúng byte + Content-Range', async () => {
      const r = await driver.getObjectStreamRange(key, 'bytes=2-5');
      expect(r.statusCode).toBe(206);
      expect(r.contentRange).toBe('bytes 2-5/10');
      expect(r.contentLength).toBe(4);
      await expect(readAll(r.body)).resolves.toEqual(Buffer.from('2345'));
    });

    it('key không tồn tại + có range → vẫn NoSuchKey (không lộ hành vi khác)', async () => {
      await expect(
        driver.getObjectStreamRange('missing.mp3', 'bytes=0-1'),
      ).rejects.toThrow(StorageObjectNotFoundError);
    });
  });

  describe('delete', () => {
    it('xoá key đang tồn tại → getObjectStream sau đó throw NoSuchKey', async () => {
      const key = 'a/b.txt';
      await driver.upload(key, Buffer.from('x'), 'text/plain');
      await driver.delete(key);
      await expect(driver.getObjectStream(key)).rejects.toThrow(
        StorageObjectNotFoundError,
      );
    });

    it('xoá key KHÔNG tồn tại — idempotent, KHÔNG throw', async () => {
      await expect(driver.delete('khong-bao-gio-ton-tai.txt')).resolves.toBeUndefined();
    });
  });

  describe('getPresignedUrl', () => {
    it('LUÔN throw PresignNotSupportedError (đĩa cục bộ không có URL chữ ký)', async () => {
      await expect(driver.getPresignedUrl('any-key.jpg')).rejects.toThrow(
        PresignNotSupportedError,
      );
    });
  });
});
