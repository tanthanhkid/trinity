import { actionToolByName } from '../actions/action-registry';
import { ActionUserError } from '../actions/action-types';
import { mergeOptions, optionsFromCaption } from '../actions/action-social-tools';
import { listYoutubePlaylistsTool } from '../tools/social-tools';
import { SocialPostsService } from '../../../social/social-posts.service';

const user = { userId: 1, email: 'a@x.vn', isAdmin: true, grants: {} } as never;
const future = (min: number) => new Date(Date.now() + min * 60_000);

describe('create_social_post — tuỳ chọn YouTube / Facebook', () => {
  it('captions → options gửi BE', () => {
    expect(
      optionsFromCaption({
        youtube_title: ' Bánh ', youtube_privacy: 'public', youtube_description: 'Mô tả', youtube_tags: ['bánh', 1, 'ngọt'], youtube_category: '26',
        youtube_made_for_kids: false, youtube_thumbnail_media_key: 'social/t.png', youtube_playlist_id: 'PLabcdefghij12', facebook_first_comment: 'Link mua',
      }),
    ).toEqual({ title: 'Bánh', privacy: 'public', description: 'Mô tả', tags: ['bánh', 'ngọt'], category_id: '26', made_for_kids: false, thumbnail_key: 'social/t.png', playlist_id: 'PLabcdefghij12', first_comment: 'Link mua' });
    expect(optionsFromCaption({ caption: 'chỉ nội dung' })).toEqual({});
  });

  it('sửa bài: chuỗi rỗng bỏ tuỳ chọn đã lưu, trường không gửi thì giữ', () => {
    const stored = { title: 'T', playlist_id: 'PL1', thumbnail_key: 'social/t.png', first_comment: 'Link', tags: ['a'] };
    expect(mergeOptions(stored, { youtube_playlist_id: '', facebook_first_comment: ' ', youtube_tags: ['b'] })).toEqual({ title: 'T', thumbnail_key: 'social/t.png', tags: ['b'] });
    expect(mergeOptions(stored, undefined)).toBe(stored);
  });
});

function deps(o: { editable?: unknown; editableErr?: string } = {}) {
  const post = { id: 5, content: 'Cũ', media: [{ key: 'social/v.mp4', type: 'video', content_type: 'video/mp4', size: 9 }], scheduled_at: future(300) };
  const live = [{ id: 11, account_id: 3, caption: 'riêng cũ', options: { title: 'Tiêu đề cũ', thumbnail: { key: 'social/t.png', type: 'image' } } }];
  const posts = {
    editable: jest.fn(async () => {
      if (o.editableErr) throw new Error(o.editableErr);
      return o.editable ?? { post, live };
    }),
    validate: jest.fn(async (_u: unknown, input: any) => ({
      content: input.content,
      media: post.media,
      scheduledAt: new Date(input.scheduled_at),
      targets: input.targets.map((t: any) => ({ account: { id: t.account_id, name: 'Kênh YT', network: 'youtube' }, caption: t.caption, options: t.options })),
    })),
    update: jest.fn(async () => ({ id: 5, status: 'scheduled', scheduled_at: future(400), targets: [] })),
    reschedule: jest.fn(async () => ({ id: 5, scheduled_at: future(1000) })),
    newSchedule: (at: unknown) => SocialPostsService.prototype.newSchedule.call({}, at),
    youtubePlaylists: jest.fn(async () => [{ id: 'PL1', title: 'Công thức' }]),
  };
  return { social: { posts, accounts: {} }, orgFeatures: { isEnabled: jest.fn(async () => true) } } as any;
}

describe('update_scheduled_post', () => {
  const tool = actionToolByName('update_scheduled_post')!;
  it('giữ những gì không đổi (kênh, nội dung riêng, tuỳ chọn cũ — thumbnail gửi lại bằng key), chỉ đổi phần AI đặt', async () => {
    const d = deps();
    const r = await tool.prepare({ post_id: 5, content: 'Nội dung mới', captions: [{ account_id: 3, youtube_tags: ['mới'] }], confirmed_by_user: 'ok đăng đi' }, { deps: d, user });
    const input = d.social.posts.validate.mock.calls[0][1];
    expect(input.content).toBe('Nội dung mới');
    expect(input.media_keys).toEqual(['social/v.mp4']);
    expect(input.targets).toEqual([{ account_id: 3, caption: 'riêng cũ', options: { title: 'Tiêu đề cũ', thumbnail_key: 'social/t.png', tags: ['mới'] } }]);
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

describe('list_youtube_playlists', () => {
  it('trả playlist_id + title', async () => {
    const d = deps();
    const out = await listYoutubePlaylistsTool.run({ account_id: 8 }, { deps: d, baseUrl: 'https://crm.test', principal: { userId: 1, user } as any });
    expect((out.structured as any).data).toMatchObject({ playlists: [{ playlist_id: 'PL1', title: 'Công thức' }], total: 1, next_offset: null });
  });

  it('hơn 50 playlist ⇒ phân trang bằng offset, lọc bằng search', async () => {
    const d = deps();
    d.social.posts.youtubePlaylists.mockResolvedValue(Array.from({ length: 120 }, (_, i) => ({ id: `PL${i}`, title: i === 110 ? 'Bánh mì' : `Tập ${i}` })));
    const ctx = { deps: d, baseUrl: 'https://crm.test', principal: { userId: 1, user } as any };
    const p1 = (await listYoutubePlaylistsTool.run({ account_id: 8 }, ctx)).structured as any;
    expect(p1.data).toMatchObject({ total: 120, next_offset: 50 });
    expect(p1.data.playlists).toHaveLength(50);
    const p3 = (await listYoutubePlaylistsTool.run({ account_id: 8, offset: 100 }, ctx)).structured as any;
    expect(p3.data.playlists[0].playlist_id).toBe('PL100');
    expect(p3.data.next_offset).toBeNull();
    const f = (await listYoutubePlaylistsTool.run({ account_id: 8, search: 'bánh' }, ctx)).structured as any;
    expect(f.data.playlists).toEqual([{ playlist_id: 'PL110', title: 'Bánh mì' }]);
    await expect(listYoutubePlaylistsTool.run({ account_id: 8, search: '0901' }, ctx)).rejects.toThrow(/Không hỗ trợ/);
  });
});

describe('refresh_social_post_metrics', () => {
  it('cần crm.write; kênh không trả số thì báo refresh_failed', async () => {
    const { refreshSocialPostMetricsTool } = await import('../tools/social-tools');
    expect(refreshSocialPostMetricsTool.scope).toBe('crm.write');
    const post = { id: 5, status: 'published', content: 'x', media: [], created_at: new Date(), scheduled_at: null, source: 'web', targets: [{ id: 11, account_id: 3, account_name: 'Kênh YT', network: 'youtube', status: 'published', caption: null, url: null, last_error: null, published_at: new Date(), attempts: 1, metrics: null, metrics_at: null }] };
    const d = { social: { posts: { refreshPostMetricsReport: jest.fn(async () => ({ post, failed: [11], throttled: [] })) }, accounts: {} }, orgFeatures: { isEnabled: jest.fn(async () => true) } } as any;
    const r = (await refreshSocialPostMetricsTool.run({ post_id: 5 }, { deps: d, baseUrl: 'https://crm.example', principal: {} } as never)).structured as any;
    expect(r.data.refresh_failed).toEqual([{ target_id: 11, account_name: 'Kênh YT', network: 'youtube' }]);
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
