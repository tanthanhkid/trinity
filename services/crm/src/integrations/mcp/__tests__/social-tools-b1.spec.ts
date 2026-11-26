import { actionToolByName } from '../actions/action-registry';
import { ActionUserError } from '../actions/action-types';
import { mergeOptions, optionsFromCaption } from '../actions/action-social-tools';
import { SocialPostsService } from '../../../social/social-posts.service';

const user = { userId: 1, email: 'a@x.vn', isAdmin: true, grants: {} } as never;
const future = (min: number) => new Date(Date.now() + min * 60_000);

describe('create_social_post — tuỳ chọn Facebook', () => {
  it('captions → options gửi BE; khoá YouTube cũ không còn được nhận', () => {
    expect(optionsFromCaption({ facebook_first_comment: ' Link mua ', youtube_title: 'Bánh', youtube_playlist_id: 'PL1' })).toEqual({ first_comment: 'Link mua' });
    expect(optionsFromCaption({ caption: 'chỉ nội dung' })).toEqual({});
  });

  it('sửa bài: chuỗi rỗng bỏ tuỳ chọn đã lưu, trường không gửi thì giữ', () => {
    const stored = { first_comment: 'Link', utm: { campaign: 'tet' } };
    expect(mergeOptions(stored, { facebook_first_comment: ' ' })).toEqual({ utm: { campaign: 'tet' } });
    expect(mergeOptions(stored, { facebook_first_comment: 'Link mới' })).toEqual({ first_comment: 'Link mới', utm: { campaign: 'tet' } });
    expect(mergeOptions(stored, undefined)).toBe(stored);
  });
});

function deps(o: { editable?: unknown; editableErr?: string } = {}) {
  const post = { id: 5, content: 'Cũ', media: [{ key: 'social/v.mp4', type: 'video', content_type: 'video/mp4', size: 9 }], scheduled_at: future(300) };
  const live = [{ id: 11, account_id: 3, caption: 'riêng cũ', options: { first_comment: 'Bình luận cũ', utm: { campaign: 'tet' } } }];
  const posts = {
    editable: jest.fn(async () => {
      if (o.editableErr) throw new Error(o.editableErr);
      return o.editable ?? { post, live };
    }),
    validate: jest.fn(async (_u: unknown, input: any) => ({
      content: input.content,
      media: post.media,
      scheduledAt: new Date(input.scheduled_at),
      targets: input.targets.map((t: any) => ({ account: { id: t.account_id, name: 'Fanpage A', network: 'facebook' }, caption: t.caption, options: t.options })),
    })),
    update: jest.fn(async () => ({ id: 5, status: 'scheduled', scheduled_at: future(400), targets: [] })),
    reschedule: jest.fn(async () => ({ id: 5, scheduled_at: future(1000) })),
    newSchedule: (at: unknown) => SocialPostsService.prototype.newSchedule.call({}, at),
  };
  return { social: { posts, accounts: {} }, orgFeatures: { isEnabled: jest.fn(async () => true) } } as any;
}

describe('update_scheduled_post', () => {
  const tool = actionToolByName('update_scheduled_post')!;
  it('giữ những gì không đổi (kênh, nội dung riêng, tuỳ chọn cũ), chỉ đổi phần AI đặt', async () => {
    const d = deps();
    const r = await tool.prepare({ post_id: 5, content: 'Nội dung mới', captions: [{ account_id: 3, facebook_first_comment: 'Bình luận mới' }], confirmed_by_user: 'ok đăng đi' }, { deps: d, user });
    const input = d.social.posts.validate.mock.calls[0][1];
    expect(input.content).toBe('Nội dung mới');
    expect(input.media_keys).toEqual(['social/v.mp4']);
    expect(input.targets).toEqual([{ account_id: 3, caption: 'riêng cũ', options: { first_comment: 'Bình luận mới', utm: { campaign: 'tet' } } }]);
    expect(r.params).toMatchObject({ post_id: 5 });
  });

  it('thiếu lời đồng ý ⇒ chỉ trả bản xem trước; bài không còn sửa được ⇒ báo rõ', async () => {
    await expect(tool.prepare({ post_id: 5, content: 'x' }, { deps: deps(), user })).rejects.toBeInstanceOf(ActionUserError);
    await expect(tool.prepare({ post_id: 5, content: 'x', confirmed_by_user: 'ok đăng đi' }, { deps: deps({ editableErr: 'Bài sắp tới giờ đăng' }), user })).rejects.toThrow(/sắp tới giờ/);
  });
});

describe('reschedule_social_post', () => {
  const tool = actionToolByName('reschedule_social_post')!;
  it('giờ VN không múi giờ ⇒ hiểu là +07:00; giờ đã qua ⇒ lỗi', async () => {
    const d = deps();
    const day = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const r = await tool.prepare({ post_id: 5, scheduled_at: `${day}T09:00` }, { deps: d, user });
    expect(r.params).toEqual({ post_id: 5, scheduled_at: `${day}T02:00:00.000Z` });
    await expect(tool.prepare({ post_id: 5, scheduled_at: '2020-01-01T09:00' }, { deps: d, user })).rejects.toThrow(/ít nhất 1 phút/);
  });
});

describe('refresh_social_post_metrics', () => {
  it('cần crm.write; kênh không trả số thì báo refresh_failed', async () => {
    const { refreshSocialPostMetricsTool } = await import('../tools/social-tools');
    expect(refreshSocialPostMetricsTool.scope).toBe('crm.write');
    const post = { id: 5, status: 'published', content: 'x', media: [], created_at: new Date(), scheduled_at: null, source: 'web', targets: [{ id: 11, account_id: 3, account_name: 'Fanpage A', network: 'facebook', status: 'published', caption: null, url: null, last_error: null, published_at: new Date(), attempts: 1, metrics: null, metrics_at: null }] };
    const d = { social: { posts: { refreshPostMetricsReport: jest.fn(async () => ({ post, failed: [11], throttled: [] })) }, accounts: {} }, orgFeatures: { isEnabled: jest.fn(async () => true) } } as any;
    const r = (await refreshSocialPostMetricsTool.run({ post_id: 5 }, { deps: d, baseUrl: 'https://crm.example', principal: {} } as never)).structured as any;
    expect(r.data.refresh_failed).toEqual([{ target_id: 11, account_name: 'Fanpage A', network: 'facebook' }]);
    d.social.posts.refreshPostMetricsReport.mockResolvedValueOnce({ post, failed: [], throttled: [11] });
    const again = (await refreshSocialPostMetricsTool.run({ post_id: 5 }, { deps: d, baseUrl: 'https://crm.example', principal: {} } as never)).structured as any;
    expect(again.data).toMatchObject({ refresh_failed: [], not_refreshed: [{ target_id: 11 }] });
  });
});

describe('update_scheduled_post — chế độ duyệt', () => {
  it('chỉ lưu phần sửa; lúc chạy ghép với bài HIỆN TẠI (bài sửa trên giao diện trong lúc chờ duyệt không bị ghi đè)', async () => {
    const tool = actionToolByName('update_scheduled_post')!;
    const d = deps();
    const r = await tool.prepare({ post_id: 5, content: 'Nội dung AI', confirmed_by_user: 'ok đăng đi' }, { deps: d, user });
    expect(r.params).toEqual({ post_id: 5, patch: { content: 'Nội dung AI' } });
    // Trong lúc chờ duyệt, người dùng đổi nội dung riêng của kênh trên giao diện.
    const newer = { post: { id: 5, content: 'Cũ', media: [], scheduled_at: future(500) }, live: [{ id: 11, account_id: 3, caption: 'riêng MỚI', options: {} }] };
    d.social.posts.editable.mockResolvedValue(newer);
    await tool.execute(r.params, { deps: d, user } as never, 1);
    const input = d.social.posts.update.mock.calls[0][2];
    expect(input.content).toBe('Nội dung AI');
    expect(input.targets).toEqual([{ account_id: 3, caption: 'riêng MỚI', options: {} }]);
    expect(input.scheduled_at).toBe(newer.post.scheduled_at.toISOString());
  });
});

describe('update_scheduled_post — giờ sát hiện tại', () => {
  it('giờ mới chưa tới 1 phút nữa ⇒ báo ngay lúc chuẩn bị', async () => {
    const tool = actionToolByName('update_scheduled_post')!;
    const soon = new Date(Date.now() + 30_000 + 7 * 3_600_000).toISOString().slice(0, 19);
    await expect(tool.prepare({ post_id: 5, scheduled_at: soon, confirmed_by_user: 'ok' }, { deps: deps(), user })).rejects.toThrow(/ít nhất 1 phút/);
  });
});

describe('reschedule_social_post — giới hạn 90 ngày', () => {
  it('quá 90 ngày ⇒ báo ngay lúc chuẩn bị', async () => {
    const tool = actionToolByName('reschedule_social_post')!;
    const far = new Date(Date.now() + 100 * 86_400_000 + 7 * 3_600_000).toISOString().slice(0, 16);
    await expect(tool.prepare({ post_id: 5, scheduled_at: far }, { deps: deps(), user })).rejects.toThrow(/90 ngày/);
  });
});
