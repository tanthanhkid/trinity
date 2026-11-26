import { BadRequestException } from '@nestjs/common';
import { StorageService } from './storage.service';
import { SocialMediaService } from '../social/social-media.service';
import { NewsfeedController } from '../newsfeed/newsfeed.controller';

describe('sau khi gỡ Vercel Blob', () => {
  const OLD = { ...process.env };
  afterEach(() => {
    process.env = { ...OLD };
  });

  it('STORAGE_DRIVER=vercel-blob ⇒ StorageService ném lỗi khi dựng (lúc khởi động), kèm hướng dẫn chuyển dữ liệu', () => {
    process.env.STORAGE_DRIVER = 'vercel-blob';
    expect(() => new StorageService()).toThrow(/không còn được hỗ trợ[\s\S]*STORAGE_LOCAL_ROOT/);
  });

  it('chỉ có BLOB_READ_WRITE_TOKEN ⇒ cũng ném, không âm thầm dùng đĩa', () => {
    delete process.env.STORAGE_DRIVER;
    process.env.BLOB_READ_WRITE_TOKEN = 'x';
    expect(() => new StorageService()).toThrow(/BLOB_READ_WRITE_TOKEN/);
  });

  it('upload-token (kiểm trước) và stub video: 400 với đúng thông điệp cũ (client cũ tự chuyển multipart)', () => {
    const media = new SocialMediaService({} as never, {} as never);
    const user = { userId: 1 } as never;
    const newsfeed = Object.create(NewsfeedController.prototype) as NewsfeedController;
    for (const [fn, re] of [
      [() => media.uploadToken(user, 'a.png', 10), /upload trực tiếp — gửi tệp qua POST \/social\/media/],
      [() => media.uploadToken(user, 'a.png', 50 * 1024 * 1024), /Tệp quá lớn/],
      [() => newsfeed.videoUploadTokenGone(), /upload trực tiếp — gửi video qua \/newsfeed\/upload/],
    ] as const) {
      expect(fn).toThrow(BadRequestException);
      expect(fn).toThrow(re);
    }
  });
});
