import { Readable } from 'node:stream';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { of } from 'rxjs';
import * as safeGet from '../../integrations/common/safe-http-get';
import { SocialMediaService } from '../social-media.service';
import { DEFAULT_MAX_VIDEO_MB, MAX_STORED_VIDEO_BYTES, maxVideoBytes } from '../social.config';
import { MulterError } from 'multer';
import { SocialUploadInterceptor, uploadError } from '../social-upload.interceptor';

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
  return uploadNamed(bytes, 'clip.mp4', truncated);
}

async function uploadNamed(bytes: number, name: string, truncated = false) {
  const req = multipartRequest(bytes, name, truncated);
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

  it('câu lỗi vượt trần: video theo env (95 ⇒ "tối đa 95 MB"), ảnh 10 MB; đều 413', () => {
    const tooLarge = new MulterError('LIMIT_FILE_SIZE', 'file');
    const v = uploadError(tooLarge, 95 * MB) as PayloadTooLargeException;
    expect(v).toBeInstanceOf(PayloadTooLargeException);
    expect(v.message).toBe('Tệp quá lớn (tối đa 95 MB).');
    expect((uploadError(tooLarge, 10 * MB) as Error).message).toBe('Tệp quá lớn (tối đa 10 MB).');
    expect(uploadError(new MulterError('LIMIT_UNEXPECTED_FILE', 'x'), MB)).toBeInstanceOf(BadRequestException);
    const fsErr = Object.assign(new Error('ENOSPC'), { syscall: 'write' });
    expect(uploadError(fsErr, MB)).toBe(fsErr);
  });

  it('multer chặn thật ở trần: ảnh 11 MB ⇒ 413 "tối đa 10 MB"; uploadFile vượt trần loại ⇒ 413', async () => {
    process.env.SOCIAL_MAX_VIDEO_MB = '1';
    const err = await uploadNamed(11 * MB, 'anh.png').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayloadTooLargeException);
    expect((err as Error).message).toBe('Tệp quá lớn (tối đa 10 MB).');
    const svc = new SocialMediaService({ upload: jest.fn() } as never, {} as never);
    await expect(svc.uploadFile({ userId: 1 } as never, { originalname: 'clip.mp4', path: '/nonexistent', size: 2 * MB })).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('nhập từ link và tải qua upload-token: video vượt trần env nhận câu lỗi của Trinity', async () => {
    process.env.SOCIAL_MAX_VIDEO_MB = '1';
    const storage = { upload: jest.fn(), isClientUploadSupported: () => false, createClientUpload: jest.fn(() => ({})) };
    const prisma = { socialMediaAsset: { upsert: jest.fn() } };
    const svc = new SocialMediaService(storage as never, prisma as never);
    jest.spyOn(safeGet, 'safeGetMedia').mockResolvedValueOnce({ contentType: 'video/mp4', body: Buffer.alloc(2 * MB) });
    await expect(svc.importFromUrl({ userId: 1 } as never, 'https://cdn.example.com/clip.mp4')).rejects.toThrow('Tệp quá lớn (tối đa 1 MB).');
    expect(storage.upload).not.toHaveBeenCalled();
    // upload-token kiểm cỡ TRƯỚC nhánh môi trường: VPS (không upload trực tiếp) cũng chặn tệp quá trần trước khi gửi.
    const tooBig = (() => { try { svc.uploadToken({ userId: 1 } as never, 'clip.mp4', 2 * MB); } catch (e) { return e as BadRequestException; } })();
    expect(tooBig?.getResponse()).toMatchObject({ message: 'Tệp quá lớn (tối đa 1 MB).', max_bytes: MB });
    const vps = (() => { try { svc.uploadToken({ userId: 1 } as never, 'clip.mp4', MB); } catch (e) { return e as BadRequestException; } })();
    expect(vps?.getResponse()).toMatchObject({ message: expect.stringMatching(/upload trực tiếp/), max_bytes: MB });
    expect(() => svc.uploadToken({ userId: 1 } as never, 'a.txt', 1)).toThrow(/Chỉ nhận/);
  });

  it('hạ trần không làm hỏng video đã lưu: resolve/load dùng trần cứng 200 MB', async () => {
    process.env.SOCIAL_MAX_VIDEO_MB = '1';
    const key = 'social/u1_1700000000000_abc123.mp4';
    const storage = {
      getObjectStreamRange: jest.fn().mockResolvedValue({ body: { destroy: jest.fn() }, contentRange: `bytes 0-0/${150 * MB}` }),
      getObjectStream: jest.fn().mockResolvedValue({ body: Readable.from([Buffer.alloc(2 * MB)]) }),
    };
    const prisma = { socialMediaAsset: { findMany: jest.fn().mockResolvedValue([]) } };
    const svc = new SocialMediaService(storage as never, prisma as never);
    await expect(svc.resolve({ userId: 1 } as never, [key])).resolves.toEqual([{ key, type: 'video', content_type: 'video/mp4', size: 150 * MB }]);
    await expect(svc.load({ key, type: 'video', content_type: 'video/mp4', size: 2 * MB })).resolves.toBeDefined(); // 2 MB > env 1 MB vẫn nạp được
    expect(MAX_STORED_VIDEO_BYTES).toBe(200 * MB);
  });
});
