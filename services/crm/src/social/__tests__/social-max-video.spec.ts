import { Readable } from 'node:stream';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { of } from 'rxjs';
import * as safeGet from '../../integrations/common/safe-http-get';
import { SocialMediaService } from '../social-media.service';
import { DEFAULT_MAX_VIDEO_MB, MAX_STORED_VIDEO_BYTES, maxVideoBytes } from '../social.config';
import { SocialUploadInterceptor } from '../social-upload.interceptor';

const MB = 1024 * 1024;
const ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ENV };
  jest.restoreAllMocks();
});

/** Request multipart giả: một tệp `file` cỡ `bytes`, phát từng 1 MB (không giữ cả tệp trong RAM). */
function multipartRequest(bytes: number, name = 'clip.mp4', truncated = false) {
  const boundary = 'trinityTestBoundary';
  async function* body() {
    yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: video/mp4\r\n\r\n`);
    const chunk = Buffer.alloc(MB);
    for (let left = bytes; left > 0; left -= MB) yield left >= MB ? chunk : chunk.subarray(0, left);
    if (!truncated) yield Buffer.from(`\r\n--${boundary}--\r\n`);
  }
  return Object.assign(Readable.from(body()), {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'transfer-encoding': 'chunked' },
  });
}

async function upload(bytes: number, truncated = false) {
  const req = multipartRequest(bytes, 'clip.mp4', truncated);
  const ctx = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }) };
  await new SocialUploadInterceptor().intercept(ctx as never, { handle: () => of('ok') });
  return (req as unknown as { file?: { size: number; path: string } }).file;
}

describe('SOCIAL_MAX_VIDEO_MB', () => {
  it('mặc định 200 MB như trước; giá trị sai ⇒ mặc định', () => {
    expect(DEFAULT_MAX_VIDEO_MB).toBe(200);
    expect(maxVideoBytes({})).toBe(200 * MB);
    expect(maxVideoBytes({ SOCIAL_MAX_VIDEO_MB: 'abc' })).toBe(200 * MB);
    expect(maxVideoBytes({ SOCIAL_MAX_VIDEO_MB: '0' })).toBe(200 * MB);
    expect(maxVideoBytes({ SOCIAL_MAX_VIDEO_MB: '95' })).toBe(95 * MB);
    expect(maxVideoBytes({ SOCIAL_MAX_VIDEO_MB: '95.5' })).toBe(200 * MB); // chỉ MB nguyên
    expect(maxVideoBytes({ SOCIAL_MAX_VIDEO_MB: '500' })).toBe(200 * MB); // không vượt trần cứng của video đã lưu
  });

  it('body multipart bị cắt ngang ⇒ 400, không thành 500', async () => {
    const err = await upload(1 * MB, true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
  });

  it('trần multer không thấp hơn trần ảnh khi video đặt nhỏ', async () => {
    process.env.SOCIAL_MAX_VIDEO_MB = '1';
    const f = await upload(5 * MB);
    expect(f?.size).toBe(5 * MB);
    await import('node:fs/promises').then((fs) => fs.unlink(f!.path));
  });

  it('tải multipart: đặt 95 ⇒ tệp 96 MB nhận câu lỗi của Trinity; tệp nhỏ vẫn qua', async () => {
    process.env.SOCIAL_MAX_VIDEO_MB = '95';
    const err = await upload(96 * MB).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayloadTooLargeException);
    expect((err as Error).message).toBe('Tệp quá lớn (tối đa 95 MB).');
    const f = await upload(2 * MB);
    expect(f?.size).toBe(2 * MB);
    await import('node:fs/promises').then((fs) => fs.unlink(f!.path));
  }, 30_000);

  it('nhập từ link và tải qua upload-token: đặt 95 ⇒ video 96 MB nhận câu lỗi của Trinity', async () => {
    process.env.SOCIAL_MAX_VIDEO_MB = '95';
    const storage = { upload: jest.fn(), isClientUploadSupported: () => false, createClientUpload: jest.fn(() => ({})) };
    const prisma = { socialMediaAsset: { upsert: jest.fn() } };
    const svc = new SocialMediaService(storage as never, prisma as never);
    jest.spyOn(safeGet, 'safeGetMedia').mockResolvedValueOnce({ contentType: 'video/mp4', body: Buffer.alloc(96 * MB) });
    await expect(svc.importFromUrl({ userId: 1 } as never, 'https://cdn.example.com/clip.mp4')).rejects.toThrow('Tệp quá lớn (tối đa 95 MB).');
    expect(storage.upload).not.toHaveBeenCalled();
    // upload-token kiểm cỡ TRƯỚC nhánh môi trường: VPS (không upload trực tiếp) cũng chặn tệp quá trần trước khi gửi.
    const tooBig = (() => { try { svc.uploadToken({ userId: 1 } as never, 'clip.mp4', 96 * MB); } catch (e) { return e as BadRequestException; } })();
    expect(tooBig?.getResponse()).toMatchObject({ message: 'Tệp quá lớn (tối đa 95 MB).', max_bytes: 95 * MB });
    const vps = (() => { try { svc.uploadToken({ userId: 1 } as never, 'clip.mp4', 95 * MB); } catch (e) { return e as BadRequestException; } })();
    expect(vps?.getResponse()).toMatchObject({ message: expect.stringMatching(/upload trực tiếp/), max_bytes: 95 * MB });
    expect(() => svc.uploadToken({ userId: 1 } as never, 'a.txt', 1)).toThrow(/Chỉ nhận/);
  });

  it('hạ trần không làm hỏng video đã lưu: resolve/load dùng trần cứng 200 MB', async () => {
    process.env.SOCIAL_MAX_VIDEO_MB = '95';
    const key = 'social/u1_1700000000000_abc123.mp4';
    const storage = {
      getObjectStreamRange: jest.fn().mockResolvedValue({ body: { destroy: jest.fn() }, contentRange: `bytes 0-0/${150 * MB}` }),
      getObjectStream: jest.fn().mockResolvedValue({ body: Readable.from([Buffer.alloc(96 * MB)]) }),
    };
    const prisma = { socialMediaAsset: { findMany: jest.fn().mockResolvedValue([]) } };
    const svc = new SocialMediaService(storage as never, prisma as never);
    await expect(svc.resolve({ userId: 1 } as never, [key])).resolves.toEqual([{ key, type: 'video', content_type: 'video/mp4', size: 150 * MB }]);
    await expect(svc.load({ key, type: 'video', content_type: 'video/mp4', size: 96 * MB })).resolves.toBeDefined(); // 96 MB > env 95 vẫn nạp được
    expect(MAX_STORED_VIDEO_BYTES).toBe(200 * MB);
  });
});
