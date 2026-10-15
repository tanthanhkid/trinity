import { previewSocialPostTool } from '../tools/social-tools';

const user = { userId: 1, email: 'a@x.vn', isAdmin: true, grants: {} } as never;
const T = { account_id: 1, account_name: 'Fanpage', network: 'facebook', text: 'x', title: null, description: null, first_comment: null, length: 1, limit: 63206, truncated_at: null, media: [], warnings: [] };

function deps(over: Record<string, unknown> = {}) {
  const posts = { preview: jest.fn(async () => ({ scheduled_at: null, from_queue: false, warnings: [], targets: [T], ...over })), create: jest.fn() };
  return { social: { posts }, orgFeatures: { isEnabled: jest.fn(async () => true) } } as any;
}
const ctx = (d: any) => ({ deps: d, baseUrl: 'https://crm.example.com', principal: { user } }) as never;

describe('preview_social_post', () => {
  it('quyền social.post, chỉ đọc, mô tả song ngữ, không có confirmed_by_user', () => {
    expect(previewSocialPostTool.permissions).toEqual(['social.post']);
    expect(previewSocialPostTool.scope).toBeUndefined();
    expect(previewSocialPostTool.description).toMatch(/\//);
    expect(Object.keys(previewSocialPostTool.input({ ...require('zod').z } as never))).not.toContain('confirmed_by_user');
  });

  it('chuyển đầu vào (caption, tuỳ chọn YouTube, UTM, giờ VN) sang posts.preview và nói chưa đăng gì', async () => {
    const d = deps();
    const r = await previewSocialPostTool.run(
      { content: 'Chào', account_ids: [1, 2], captions: [{ account_id: 2, caption: 'Riêng', youtube_title: 'Tiêu đề', facebook_first_comment: 'cmt' }], scheduled_at: '2026-10-20T09:00', utm_campaign: 'thu' },
      ctx(d),
    );
    const arg = d.social.posts.preview.mock.calls[0][1];
    expect(arg.targets).toEqual([
      { account_id: 1, caption: null, options: {} },
      { account_id: 2, caption: 'Riêng', options: { title: 'Tiêu đề', first_comment: 'cmt' } },
    ]);
    expect(arg.scheduled_at).toBe('2026-10-20T02:00:00.000Z');
    expect(arg.utm).toEqual({ campaign: 'thu' });
    const data = r.structured.data as any;
    expect(data.channels).toHaveLength(1);
    expect(data.next_step).toMatch(/CHƯA ĐĂNG/);
    expect(d.social.posts.create).not.toHaveBeenCalled();
  });

  it('use_queue: không gửi scheduled_at, báo giờ khung bằng giờ VN', async () => {
    const d = deps({ scheduled_at: '2026-10-20T02:00:00.000Z', from_queue: true });
    const r = await previewSocialPostTool.run({ content: 'x', account_ids: [1], use_queue: true }, ctx(d));
    expect(d.social.posts.preview.mock.calls[0][1]).toMatchObject({ scheduled_at: null, use_queue: true });
    expect((r.structured.data as any).scheduled_at).toMatch(/09:00 Thứ Ba 20\/10\/2026/);
  });

  it('captions sai account_id và lỗi 400 của service thành lỗi AI sửa được', async () => {
    const d = deps();
    await expect(previewSocialPostTool.run({ account_ids: [1], captions: [{ account_id: 9 }] }, ctx(d))).rejects.toThrow(/không nằm trong account_ids/);
    d.social.posts.preview.mockRejectedValueOnce(Object.assign(new Error('Chọn ít nhất một kênh.'), { status: 400 }));
    await expect(previewSocialPostTool.run({ account_ids: [1] }, ctx(d))).rejects.toThrow(/ít nhất một kênh/);
  });
});
