import { BadRequestException } from '@nestjs/common';
import { SocialPostsService } from '../social-posts.service';
import { truncatedAt } from '../social.config';

const user = { userId: 1, email: 'a@x.vn', isAdmin: true, grants: {} } as never;
const video = { key: 'social/v.mp4', type: 'video', content_type: 'video/mp4', size: 10 };
const ACCOUNTS = [
  { id: 1, network: 'facebook', name: 'Fanpage', status: 'active' },
  { id: 2, network: 'youtube', name: 'Kênh YT', status: 'active' },
  { id: 3, network: 'instagram', name: 'IG', status: 'reauth' },
];

function setup(opts: { validateMedia?: (m: unknown[]) => string | null; slot?: Date | null } = {}) {
  const prisma = { socialAccount: { findMany: jest.fn(async () => ACCOUNTS) }, socialPost: { create: jest.fn() } };
  const media = { resolve: jest.fn(async (_u: unknown, keys: string[]) => keys.map(() => video)) };
  const provider = { supported: true, validateMedia: opts.validateMedia ?? (() => null), validateOptions: () => null };
  const queue = { nextFree: jest.fn(async () => (opts.slot === null ? [] : [opts.slot ?? new Date('2026-10-20T02:00:00Z')])) };
  const svc = new SocialPostsService(prisma as never, {} as never, media as never, { get: () => provider } as never, queue as never);
  return { svc, prisma, media, queue };
}

describe('truncatedAt (điểm "Xem thêm" xấp xỉ)', () => {
  it('chữ ngắn ⇒ null', () => {
    expect(truncatedAt('facebook', 'xin chào')).toBeNull();
    expect(truncatedAt('instagram', 'a'.repeat(125))).toBeNull();
  });
  it('quá số ký tự ⇒ cắt tại mốc của mạng', () => {
    expect(truncatedAt('instagram', 'a'.repeat(200))).toBe(125);
    expect(truncatedAt('tiktok', 'a'.repeat(200))).toBe(150);
    expect(truncatedAt('google_business', 'a'.repeat(1400))).toBeNull();
  });
  it('Facebook: quá 5 dòng ⇒ gập sau dòng thứ 5', () => {
    const t = 'a\nb\nc\nd\ne\nf';
    expect(truncatedAt('facebook', t)).toBe(9);
    expect(truncatedAt('facebook', 'a\nb\nc\nd\ne')).toBeNull();
  });
});

describe('SocialPostsService.preview', () => {
  it('trả đúng chữ sẽ gửi sau UTM, không ghi gì', async () => {
    const { svc, prisma } = setup();
    const r = await svc.preview(user, { content: 'Xem https://shop.vn/a', targets: [{ account_id: 1, options: { first_comment: 'Link: https://shop.vn/b' } }], utm: { campaign: 'thu' } });
    const t = r.targets[0];
    expect(t.text).toBe('Xem https://shop.vn/a?utm_source=facebook&utm_medium=social&utm_campaign=thu');
    expect(t.first_comment).toContain('utm_source=facebook');
    expect(t.length).toBe(t.text.length);
    expect(t.limit).toBe(63_206);
    expect(t.network).toBe('facebook');
    expect(prisma.socialPost.create).not.toHaveBeenCalled();
  });

  it('YouTube: tiêu đề từ chữ sạch, mô tả sau UTM', async () => {
    const { svc } = setup();
    const r = await svc.preview(user, { content: 'Tiêu đề https://shop.vn\ndòng 2', media_keys: ['social/v.mp4'], targets: [{ account_id: 2, options: { description: 'Mô tả https://shop.vn/m' } }], utm: { campaign: 'thu' } });
    const t = r.targets[0];
    expect(t.title).toBe('Tiêu đề https://shop.vn');
    expect(t.description).toContain('utm_source=youtube');
    expect(t.media).toEqual([{ key: 'social/v.mp4', type: 'video' }]);
  });

  it('lỗi giới hạn / tệp / kênh cần liên kết lại thành warnings, không ném', async () => {
    const { svc } = setup({ validateMedia: () => 'Instagram: cần ảnh hoặc video.' });
    const r = await svc.preview(user, { content: 'x'.repeat(2300), targets: [{ account_id: 3 }, { account_id: 99 }] });
    expect(r.targets[0].warnings.join('|')).toMatch(/liên kết lại/);
    expect(r.targets[0].warnings.join('|')).toMatch(/2300 ký tự/);
    expect(r.targets[0].warnings.join('|')).toMatch(/cần ảnh hoặc video/);
    expect(r.targets[1].warnings.join('|')).toMatch(/Không tìm thấy kênh #99/);
    expect(r.targets[0].truncated_at).toBe(125);
  });

  it('thiếu cả chữ lẫn tệp ⇒ cảnh báo chung; tệp không đọc được ⇒ cảnh báo, không ném', async () => {
    const { svc, media } = setup();
    expect((await svc.preview(user, { content: '  ', targets: [{ account_id: 1 }] })).warnings).toContain('Bài cần có nội dung hoặc ảnh/video.');
    media.resolve.mockRejectedValueOnce(new BadRequestException('Không tìm thấy tệp "k".'));
    const r = await svc.preview(user, { content: 'x', media_keys: ['k'], targets: [{ account_id: 1 }] });
    expect(r.warnings).toEqual(['Không tìm thấy tệp "k".']);
    expect(r.targets[0].media).toEqual([]);
    // Lỗi hạ tầng (storage) không lộ chi tiết nội bộ
    media.resolve.mockRejectedValueOnce(new Error('AccessDenied: bucket internal-xyz'));
    const r2 = await svc.preview(user, { content: 'x', media_keys: ['k2'], targets: [{ account_id: 1 }] });
    expect(r2.warnings).toEqual(['Không kiểm tra được tệp đính kèm lúc này — thử lại sau.']);
  });

  it('use_queue: đọc khung trống, không giữ chỗ; hết khung ⇒ cảnh báo', async () => {
    const a = setup();
    const r = await a.svc.preview(user, { content: 'x', targets: [{ account_id: 1 }], use_queue: true });
    expect(r.scheduled_at).toBe('2026-10-20T02:00:00.000Z');
    expect(r.from_queue).toBe(true);
    expect(a.queue.nextFree).toHaveBeenCalledWith(1);
    const b = setup({ slot: null });
    expect((await b.svc.preview(user, { content: 'x', targets: [{ account_id: 1 }], use_queue: true })).warnings[0]).toMatch(/khung giờ hàng đợi/);
  });

  it('giờ hẹn sai ⇒ cảnh báo; không chọn kênh ⇒ 400', async () => {
    const { svc } = setup();
    expect((await svc.preview(user, { content: 'x', targets: [{ account_id: 1 }], scheduled_at: '2020-01-01T00:00:00Z' })).warnings[0]).toMatch(/đã qua/);
    await expect(svc.preview(user, { content: 'x', targets: [] })).rejects.toThrow(/ít nhất một kênh/);
  });
});
