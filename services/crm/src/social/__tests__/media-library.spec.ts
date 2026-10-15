import { BadRequestException } from '@nestjs/common';
import * as safeGet from '../../integrations/common/safe-http-get';
import { SafeGetError } from '../../integrations/common/safe-http-get';
import { uploadSocialMediaTool } from '../../integrations/mcp/tools/social-tools';
import { SocialMediaService, displayName, extFor } from '../social-media.service';

const user = { userId: 7 } as never;

function setup(shared: string[] = []) {
  const storage = {
    upload: jest.fn().mockResolvedValue('ok'),
    getObjectStreamRange: jest.fn().mockResolvedValue({ body: { destroy: jest.fn() }, contentRange: 'bytes 0-0/1234' }),
  };
  const prisma = {
    socialMediaAsset: {
      findMany: jest.fn().mockResolvedValue(shared.map((key) => ({ key }))),
      upsert: jest.fn().mockImplementation(({ create }) => Promise.resolve({ id: 1, ...create, created_at: new Date() })),
    },
  };
  return { svc: new SocialMediaService(storage as never, prisma as never), storage, prisma };
}

afterEach(() => jest.restoreAllMocks());

describe('thư viện media đăng bài', () => {
  it('đuôi tệp theo content-type, không thì theo tên', () => {
    expect(extFor('image/jpeg')).toBe('.jpg');
    expect(extFor('video/quicktime')).toBe('.mov');
    expect(extFor('application/octet-stream', 'https://x.com/a/banner.PNG?v=2')).toBe('.png');
    expect(extFor('text/html', 'trang.html')).toBeNull();
  });

  it('tên hiển thị bỏ đường dẫn, rỗng thì dùng mặc định', () => {
    expect(displayName('C:\\Users\\a\\anh-bia.png', 'k')).toBe('anh-bia.png');
    expect(displayName('  ', 'mac-dinh')).toBe('mac-dinh');
  });

  it('khoá của người khác chỉ dùng được khi đang có trong thư viện chung', async () => {
    const key = 'social/u9_1700000000000_abc123.png';
    await expect(setup().svc.resolve(user, [key])).rejects.toThrow(BadRequestException);
    await expect(setup([key]).svc.resolve(user, [key])).resolves.toEqual([{ key, type: 'image', content_type: 'image/png', size: 1234 }]);
  });

  it('base64 ảnh nhỏ ⇒ lưu kho + vào thư viện (nguồn mcp)', async () => {
    const { svc, storage, prisma } = setup();
    const r = await svc.importBase64(user, `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`, 'banner.png');
    expect(storage.upload.mock.calls[0][0]).toMatch(/^social\/u7_\d+_[a-z0-9]+\.png$/);
    expect(prisma.socialMediaAsset.upsert.mock.calls[0][0].create).toMatchObject({ type: 'image', name: 'banner.png', source: 'mcp', uploaded_by: 7, size: 9 });
    expect(r.key).toBe(storage.upload.mock.calls[0][0]);
  });

  it('base64 sai / quá lớn / thiếu đuôi ⇒ lỗi dễ hiểu', async () => {
    const { svc } = setup();
    await expect(svc.importBase64(user, '%%%', 'a.png')).rejects.toThrow(/base64/);
    await expect(svc.importBase64(user, 'A'.repeat(5_000_000), 'a.png')).rejects.toThrow(/tối đa 3 MB/);
    await expect(svc.importBase64(user, 'QUJD', 'a.txt')).rejects.toThrow(/đuôi/);
  });

  it('tải từ link: lấy tên từ đường dẫn; lỗi chặn SSRF đổi thành câu tiếng Việt', async () => {
    const { svc, prisma } = setup();
    jest.spyOn(safeGet, 'safeGetMedia').mockResolvedValueOnce({ contentType: 'image/webp', body: Buffer.from('x') });
    await svc.importFromUrl(user, 'https://cdn.example.com/anh%20moi.webp');
    expect(prisma.socialMediaAsset.upsert.mock.calls[0][0].create).toMatchObject({ name: 'anh moi.webp', content_type: 'image/webp' });
    jest.spyOn(safeGet, 'safeGetMedia').mockRejectedValueOnce(new SafeGetError('blocked_target'));
    await expect(svc.importFromUrl(user, 'https://10.0.0.1/a.png')).rejects.toThrow(/https công khai/);
  });
});

describe('tool upload_social_media', () => {
  const ctx = (media: Record<string, jest.Mock>) => ({
    deps: { social: { posts: { media } }, orgFeatures: { isEnabled: jest.fn().mockResolvedValue(true) } },
    baseUrl: 'https://crm.example.com',
    principal: { user },
  });
  const item = { id: 5, key: 'social/u7_1_a.png', type: 'image', content_type: 'image/png', size: 2048, name: 'a.png', source: 'mcp', uploaded_by: 7, created_at: new Date() };

  it('cần đúng một trong url / data_base64', async () => {
    await expect(uploadSocialMediaTool.run({}, ctx({}) as never)).rejects.toThrow(/đúng một/);
    await expect(uploadSocialMediaTool.run({ url: 'https://a/b.png', data_base64: 'QUJD' }, ctx({}) as never)).rejects.toThrow(/đúng một/);
    await expect(uploadSocialMediaTool.run({ data_base64: 'QUJD' }, ctx({}) as never)).rejects.toThrow(/file_name/);
  });

  it('trả media_key để dùng cho create_social_post', async () => {
    const importFromUrl = jest.fn().mockResolvedValue(item);
    const r = await uploadSocialMediaTool.run({ url: 'https://a/b.png' }, ctx({ importFromUrl }) as never);
    expect(JSON.stringify(r.structured)).toContain('"media_key":"social/u7_1_a.png"');
  });

  it('lỗi tải (400) ⇒ lỗi cho AI đọc được, không phải lỗi máy chủ', async () => {
    const importFromUrl = jest.fn().mockRejectedValue(new BadRequestException('Link không trả về ảnh hay video.'));
    await expect(uploadSocialMediaTool.run({ url: 'https://a/b' }, ctx({ importFromUrl }) as never)).rejects.toThrow('Link không trả về ảnh hay video.');
  });
});
