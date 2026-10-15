import { StorageObjectNotFoundError } from '@trinity/storage';
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import type { AuthUser } from '@trinity/rbac-nest';
import { NewsfeedService } from './newsfeed.service';
import { StorageService } from '../storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { unlink } from 'fs/promises';

// sharp thao tác file thật (decode/encode ảnh) — mock để test không phụ
// thuộc bytes ảnh hợp lệ trên đĩa; test chỉ cần verify luồng gọi storage.
jest.mock('sharp', () =>
  jest.fn(() => ({
    resize: jest.fn().mockReturnThis(),
    webp: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue(Buffer.from('fake-webp')),
  })),
);

// uploadImage/uploadVideo đọc từ file.path (diskStorage) — mock fs/promises
// để test không cần file thật trên /tmp.
jest.mock('fs/promises', () => ({
  readFile: jest.fn().mockResolvedValue(Buffer.from('fake-video')),
  unlink: jest.fn().mockResolvedValue(undefined),
}));

// uploadVideo() giờ dùng createReadStream() (OOM-safe) thay vì
// readFile() để stream trực tiếp lên MinIO. `storage.upload` bị mock ở dưới
// nên KHÔNG bao giờ đọc stream thật — nhưng Node vẫn mở file thật trên đĩa
// khi gọi createReadStream(), và vì các đường dẫn test dùng (vd
// `/tmp/fake-video.mp4`) không tồn tại, stream thật sẽ emit 'error' (ENOENT)
// KHÔNG có listener nào bắt → Node throw "Unhandled 'error' event" và CRASH
// tiến trình Jest ngay SAU khi mọi test đã báo "passed" (exit code 1, che
// giấu bởi output PASS — CI vẫn fail). Mock `createReadStream` trả về stub
// (KHÔNG mở file thật) để cách ly test khỏi hệ thống file.
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  createReadStream: jest.fn().mockReturnValue({}),
}));

function mockPrisma() {
  return {
    newsfeedPost: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    newsfeedPostLike: {
      deleteMany: jest.fn(),
      create: jest.fn(),
      count: jest.fn(),
    },
    // notifyNewPost() (fire-and-forget) đọc user.findMany — trả rỗng để
    // fan-out no-op trong test, tránh unhandled log warn.
    user: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}
type MockPrisma = ReturnType<typeof mockPrisma>;

const mockUser: AuthUser = { userId: 42, email: 'sale@example.net', isAdmin: false, grants: {} };

describe('NewsfeedService', () => {
  let service: NewsfeedService;
  let prisma: MockPrisma;
  let storage: {
    upload: jest.Mock;
    delete: jest.Mock;
    getObjectStream: jest.Mock;
    getObjectStreamRange: jest.Mock;
  };
  beforeEach(async () => {
    prisma = mockPrisma();
    storage = {
      upload: jest.fn(),
      // Default resolved — production code luôn `.catch()` giá trị trả về;
      // jest.fn() trần trả `undefined` (KHÔNG phải Promise) sẽ vỡ `.catch()`.
      delete: jest.fn().mockResolvedValue(undefined),
      getObjectStream: jest.fn(),
      getObjectStreamRange: jest.fn(),
    };
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        NewsfeedService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storage },
        {
          provide: NotificationsService,
          useValue: { createPendingLogs: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    service = mod.get(NewsfeedService);
  });

  describe('streamImage — file mất khỏi kho', () => {
    it('StorageObjectNotFoundError → 404 (không 500); lỗi khác giữ nguyên', async () => {
      prisma.newsfeedPost.findUnique.mockResolvedValue({ image_url: null, images: [{ image_url: 'newsfeed/a.webp', media_type: 'image', sort_order: 0 }] });
      storage.getObjectStreamRange.mockRejectedValueOnce(new StorageObjectNotFoundError('newsfeed/a.webp'));
      await expect(service.streamImage(1, 0)).rejects.toBeInstanceOf(NotFoundException);
      storage.getObjectStreamRange.mockRejectedValueOnce(new Error('mạng'));
      await expect(service.streamImage(1, 0)).rejects.toThrow('mạng');
    });
  });

  describe('toggleLike', () => {
    beforeEach(() => {
      prisma.newsfeedPost.findUnique.mockResolvedValue({ id: 1 });
    });

    it('chưa like → tạo like mới, liked=true', async () => {
      prisma.newsfeedPostLike.deleteMany.mockResolvedValue({ count: 0 });
      prisma.newsfeedPostLike.create.mockResolvedValue({});
      prisma.newsfeedPostLike.count.mockResolvedValue(5);
      const result = await service.toggleLike(1, mockUser);
      expect(result).toEqual({ liked: true, like_count: 5 });
      expect(prisma.newsfeedPostLike.create).toHaveBeenCalled();
    });

    it('đã like → unlike, liked=false', async () => {
      prisma.newsfeedPostLike.deleteMany.mockResolvedValue({ count: 1 });
      prisma.newsfeedPostLike.count.mockResolvedValue(2);
      const result = await service.toggleLike(1, mockUser);
      expect(result).toEqual({ liked: false, like_count: 2 });
      expect(prisma.newsfeedPostLike.create).not.toHaveBeenCalled();
    });

    it('race: deleteMany count=0 nhưng create đụng P2002 → idempotent liked=true', async () => {
      prisma.newsfeedPostLike.deleteMany.mockResolvedValue({ count: 0 });
      const p2002 = Object.assign(new Error('Unique constraint'), {
        code: 'P2002',
      });
      prisma.newsfeedPostLike.create.mockRejectedValue(p2002);
      prisma.newsfeedPostLike.count.mockResolvedValue(1);
      const result = await service.toggleLike(1, mockUser);
      expect(result).toEqual({ liked: true, like_count: 1 });
    });

    it('lỗi DB khác P2002 → propagate', async () => {
      prisma.newsfeedPostLike.deleteMany.mockResolvedValue({ count: 0 });
      prisma.newsfeedPostLike.create.mockRejectedValue(new Error('boom'));
      await expect(service.toggleLike(1, mockUser)).rejects.toThrow('boom');
    });

    it('post không tồn tại → 404', async () => {
      prisma.newsfeedPost.findUnique.mockResolvedValue(null);
      await expect(service.toggleLike(99, mockUser)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('create — orphan media cleanup', () => {
    it('upload ảnh OK + DB insert fail → gọi storage.delete để dọn blob', async () => {
      storage.upload.mockResolvedValue('newsfeed/abc.jpg');
      prisma.newsfeedPost.create.mockRejectedValue(new Error('db down'));
      const fakeImage = {
        path: '/tmp/fake-image.jpg',
        mimetype: 'image/jpeg',
        size: 10,
      } as Express.Multer.File;
      await expect(
        service.create(mockUser, 'pr', 'noi dung', [fakeImage]),
      ).rejects.toThrow('db down');
      expect(storage.delete).toHaveBeenCalledWith(
        expect.stringContaining('newsfeed/'),
      );
    });

    it('upload video OK + DB insert fail → gọi storage.delete để dọn blob', async () => {
      storage.upload.mockResolvedValue('newsfeed/abc.mp4');
      prisma.newsfeedPost.create.mockRejectedValue(new Error('db down'));
      const fakeVideo = {
        path: '/tmp/fake-video.mp4',
        originalname: 'clip.mp4',
        mimetype: 'video/mp4',
        size: 1024,
      } as Express.Multer.File;
      await expect(
        service.create(mockUser, 'pr', 'noi dung', undefined, [fakeVideo]),
      ).rejects.toThrow('db down');
      expect(storage.delete).toHaveBeenCalledWith(
        expect.stringContaining('newsfeed/'),
      );
    });

    it('video sai đuôi file → BadRequestException, KHÔNG gọi storage.upload', async () => {
      const fakeVideo = {
        path: '/tmp/fake-video.exe',
        originalname: 'clip.exe',
        mimetype: 'video/mp4',
        size: 1024,
      } as Express.Multer.File;
      await expect(
        service.create(mockUser, 'pr', 'noi dung', undefined, [fakeVideo]),
      ).rejects.toThrow('Chỉ hỗ trợ video');
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('video vượt quá 5 file → BadRequestException', async () => {
      const fakeVideos = Array.from({ length: 6 }, (_, i) => ({
        path: `/tmp/fake-video-${i}.mp4`,
        originalname: `clip${i}.mp4`,
        mimetype: 'video/mp4',
        size: 1024,
      })) as Express.Multer.File[];
      await expect(
        service.create(mockUser, 'pr', 'noi dung', undefined, fakeVideos),
      ).rejects.toThrow('Tối đa 5 video');
    });

    it('lỗi upload ảnh giữa chừng → dọn file tạm video CHƯA xử lý, KHÔNG leak', async () => {
      // Ảnh vượt 10MB (qua multer 50MB nhưng service chặn) → throw giữa vòng;
      // video phía sau chưa kịp uploadVideo → file tạm phải được create() dọn.
      (unlink as jest.Mock).mockClear();
      const bigImage = {
        path: '/tmp/big-image.jpg',
        mimetype: 'image/jpeg',
        size: 11 * 1024 * 1024,
      } as Express.Multer.File;
      const fakeVideo = {
        path: '/tmp/pending-video.mp4',
        originalname: 'clip.mp4',
        mimetype: 'video/mp4',
        size: 1024,
      } as Express.Multer.File;
      await expect(
        service.create(mockUser, 'pr', 'noi dung', [bigImage], [fakeVideo]),
      ).rejects.toThrow('tối đa 10MB');
      expect(unlink).toHaveBeenCalledWith('/tmp/pending-video.mp4');
    });

    it('không có ảnh/video → không gọi storage.delete khi DB fail', async () => {
      prisma.newsfeedPost.create.mockRejectedValue(new Error('db down'));
      await expect(
        service.create(mockUser, 'pr', 'noi dung'),
      ).rejects.toThrow('db down');
      expect(storage.delete).not.toHaveBeenCalled();
    });
  });

  describe('delete — cleanup ảnh', () => {
    it('xoá post có legacy image_url → gọi storage.delete', async () => {
      prisma.newsfeedPost.findUnique.mockResolvedValue({
        id: 1,
        author_id: mockUser.userId,
        image_url: 'newsfeed/abc.jpg',
        images: [],
      });
      prisma.newsfeedPost.delete.mockResolvedValue({});
      await service.delete(1, mockUser);
      expect(storage.delete).toHaveBeenCalledWith('newsfeed/abc.jpg');
    });

    it('xoá post có images[] mới → gọi storage.delete cho từng ảnh', async () => {
      prisma.newsfeedPost.findUnique.mockResolvedValue({
        id: 1,
        author_id: mockUser.userId,
        image_url: null,
        images: [
          { image_url: 'newsfeed/img1.webp' },
          { image_url: 'newsfeed/img2.webp' },
        ],
      });
      prisma.newsfeedPost.delete.mockResolvedValue({});
      storage.delete.mockResolvedValue(undefined);
      await service.delete(1, mockUser);
      expect(storage.delete).toHaveBeenCalledTimes(2);
      expect(storage.delete).toHaveBeenCalledWith('newsfeed/img1.webp');
      expect(storage.delete).toHaveBeenCalledWith('newsfeed/img2.webp');
    });

    it('post không có ảnh → không gọi storage.delete', async () => {
      prisma.newsfeedPost.findUnique.mockResolvedValue({
        id: 1,
        author_id: mockUser.userId,
        image_url: null,
        images: [],
      });
      prisma.newsfeedPost.delete.mockResolvedValue({});
      await service.delete(1, mockUser);
      expect(storage.delete).not.toHaveBeenCalled();
    });
  });

  describe('update/delete — tác giả HOẶC quyền newsfeed.moderate', () => {
    const otherAuthorPost = {
      id: 1,
      author_id: 999,
      image_url: null,
      images: [],
    };

    it('không phải tác giả, không có newsfeed.moderate => 403', async () => {
      prisma.newsfeedPost.findUnique.mockResolvedValue(otherAuthorPost);
      await expect(service.update(1, 'nội dung mới', mockUser)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.delete(1, mockUser)).rejects.toThrow(ForbiddenException);
    });

    it('có newsfeed.moderate => sửa/xoá được bài của người khác', async () => {
      const moderator: AuthUser = {
        userId: 1,
        email: 'mod@example.net',
        isAdmin: false,
        grants: { 'newsfeed.moderate': true },
      };
      prisma.newsfeedPost.findUnique.mockResolvedValue(otherAuthorPost);
      prisma.newsfeedPost.update.mockResolvedValue({ ...otherAuthorPost, content: 'sửa' });
      await expect(service.update(1, 'sửa', moderator)).resolves.toEqual(
        expect.objectContaining({ content: 'sửa' }),
      );

      prisma.newsfeedPost.findUnique.mockResolvedValue(otherAuthorPost);
      prisma.newsfeedPost.delete.mockResolvedValue({});
      await expect(service.delete(1, moderator)).resolves.toBeDefined();
    });
  });

  describe('deleteComment — tác giả HOẶC quyền newsfeed.moderate', () => {
    it('không phải tác giả, không có newsfeed.moderate => 403', async () => {
      (prisma as unknown as { newsfeedPostComment: { findUnique: jest.Mock; delete: jest.Mock } }).newsfeedPostComment = {
        findUnique: jest.fn().mockResolvedValue({ id: 1, user_id: 999 }),
        delete: jest.fn(),
      };
      await expect(service.deleteComment(1, mockUser)).rejects.toThrow(ForbiddenException);
    });

    it('có newsfeed.moderate => xoá được bình luận của người khác', async () => {
      const moderator: AuthUser = {
        userId: 1,
        email: 'mod@example.net',
        isAdmin: false,
        grants: { 'newsfeed.moderate': true },
      };
      (prisma as unknown as { newsfeedPostComment: { findUnique: jest.Mock; delete: jest.Mock } }).newsfeedPostComment = {
        findUnique: jest.fn().mockResolvedValue({ id: 1, user_id: 999 }),
        delete: jest.fn().mockResolvedValue({}),
      };
      await expect(service.deleteComment(1, moderator)).resolves.toEqual(
        expect.objectContaining({ message: expect.any(String) }),
      );
    });
  });
});
