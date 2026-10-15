import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { Readable } from 'stream';
import { PrismaService } from '@trinity/prisma';
import type { AuthUser } from '@trinity/rbac-nest';
import { NewsfeedService } from './newsfeed.service';
import { StorageService } from '../storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';

// Upload video thẳng lên Blob (Vercel chặn body function > 4,5MB).
const user: AuthUser = { userId: 7, email: 'a@x.vn', isAdmin: false, grants: {} };

describe('Newsfeed client upload', () => {
  let service: NewsfeedService;
  let prisma: { newsfeedPost: { create: jest.Mock } };
  let storage: {
    isClientUploadSupported: jest.Mock;
    createClientUpload: jest.Mock;
    getObjectStreamRange: jest.Mock;
    delete: jest.Mock;
  };

  beforeEach(async () => {
    prisma = { newsfeedPost: { create: jest.fn() } };
    storage = {
      isClientUploadSupported: jest.fn().mockReturnValue(true),
      createClientUpload: jest.fn().mockReturnValue({ upload_url: 'https://u', headers: { a: 'b' } }),
      getObjectStreamRange: jest.fn().mockResolvedValue({ body: Readable.from([]) }),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const mod = await Test.createTestingModule({
      providers: [
        NewsfeedService,
        { provide: PrismaService, useValue: { ...prisma, user: { findMany: jest.fn().mockResolvedValue([]) } } },
        { provide: StorageService, useValue: storage },
        { provide: NotificationsService, useValue: { createPendingLogs: jest.fn() } },
      ],
    }).compile();
    service = mod.get(NewsfeedService);
    // PrismaService mock dùng chung object `prisma.newsfeedPost`
    (service as unknown as { prisma: unknown }).prisma = {
      ...prisma,
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };
  });

  describe('createVideoUploadToken', () => {
    it('cấp khoá mang id người đăng + token giới hạn đúng loại/dung lượng', () => {
      const r = service.createVideoUploadToken(user, 'clip.MP4', 1000);
      expect(r.key).toMatch(/^newsfeed\/u7_\d+_[a-z0-9]+\.mp4$/);
      expect(r.max_bytes).toBe(40 * 1024 * 1024);
      expect(r.upload_url).toBe('https://u');
      expect(storage.createClientUpload).toHaveBeenCalledWith(r.key, 'video/mp4', 40 * 1024 * 1024);
    });

    it('từ chối đuôi lạ, quá 40MB, và môi trường không hỗ trợ (400 để FE rơi về multipart)', () => {
      expect(() => service.createVideoUploadToken(user, 'x.exe', 10)).toThrow(BadRequestException);
      expect(() => service.createVideoUploadToken(user, 'x.mp4', 41 * 1024 * 1024)).toThrow(BadRequestException);
      storage.isClientUploadSupported.mockReturnValue(false);
      expect(() => service.createVideoUploadToken(user, 'x.mp4', 10)).toThrow(BadRequestException);
    });
  });

  describe('create với video_keys', () => {
    it('chấp nhận khoá của chính mình, đã tồn tại → lưu bài với media video', async () => {
      prisma.newsfeedPost.create.mockResolvedValue({ id: 1, category: 'pr', content: 'x', images: [] });
      const key = 'newsfeed/u7_123_abc.mp4';
      await service.create(user, 'pr', 'x', undefined, undefined, [key]);
      expect(storage.getObjectStreamRange).toHaveBeenCalledWith(key, 'bytes=0-0');
      const arg = prisma.newsfeedPost.create.mock.calls[0][0];
      expect(arg.data.images.create).toEqual([
        { image_url: key, media_type: 'video', sort_order: 0 },
      ]);
    });

    it('từ chối khoá của người khác / sai định dạng, KHÔNG xoá file của người khác', async () => {
      for (const bad of ['newsfeed/u8_123_abc.mp4', '../etc/passwd', 'newsfeed/u7_1_a.exe', 'newsfeed/u7_1_a/../b.mp4']) {
        await expect(service.create(user, 'pr', 'x', undefined, undefined, [bad])).rejects.toThrow(
          BadRequestException,
        );
      }
      expect(storage.delete).not.toHaveBeenCalled();
      expect(prisma.newsfeedPost.create).not.toHaveBeenCalled();
    });

    it('khoá chưa upload (NoSuchKey) → 400', async () => {
      const err = Object.assign(new Error('nf'), { name: 'NoSuchKey' });
      storage.getObjectStreamRange.mockRejectedValue(err);
      await expect(
        service.create(user, 'pr', 'x', undefined, undefined, ['newsfeed/u7_1_a.mp4']),
      ).rejects.toThrow(/chưa được tải lên/);
    });

    it('DB insert lỗi → dọn video đã upload trực tiếp (tránh orphan)', async () => {
      prisma.newsfeedPost.create.mockRejectedValue(new Error('db down'));
      const key = 'newsfeed/u7_1_a.mp4';
      await expect(service.create(user, 'pr', 'x', undefined, undefined, [key])).rejects.toThrow('db down');
      expect(storage.delete).toHaveBeenCalledWith(key);
    });

    it('quá 5 video (gộp file + khoá) → 400', async () => {
      const keys = Array.from({ length: 6 }, (_, i) => `newsfeed/u7_${i}_a.mp4`);
      await expect(service.create(user, 'pr', 'x', undefined, undefined, keys)).rejects.toThrow(/Tối đa 5 video/);
    });
  });
});
