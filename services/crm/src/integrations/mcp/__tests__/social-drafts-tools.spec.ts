import { SocialPostsService } from '../../../social/social-posts.service';
import { actionToolByName } from '../actions/action-registry';
import { ActionUserError } from '../actions/action-types';
import { listSocialDraftsTool, saveSocialDraftTool } from '../tools/social-tools';

const user = { userId: 1, email: 'a@x.vn', isAdmin: true, grants: {} } as never;
const future = (min: number) => new Date(Date.now() + min * 60_000);
const NOW = new Date('2026-10-15T03:00:00Z');

const row = (over: Record<string, unknown> = {}) => ({
  id: 4, title: 'Khuyến mãi', content: 'Nội dung', media: [{ key: 'social/u1_1_a.png', type: 'image', content_type: 'image/png', size: 5, name: 'a.png' }],
  targets: [{ account_id: 3, caption: 'riêng', options: { title: 'Tiêu đề', privacy: 'public', first_comment: 'Link' } }],
  scheduled_at: new Date('2026-10-20T02:00:00Z'), ui: null, post_id: null, source: 'mcp', created_by: 1, created_at: NOW, updated_at: NOW, ...over,
});

function deps(cur: ReturnType<typeof row> = row()) {
  const drafts = {
    list: jest.fn(async () => ({ data: [cur] })),
    get: jest.fn(async () => cur),
    create: jest.fn(async (_u: unknown, input: any) => ({ ...row({ targets: [], media: [], scheduled_at: null, title: null, content: '' }), ...input })),
    update: jest.fn(async (_u: unknown, _id: number, input: any) => ({ ...cur, ...input })),
    toPostInput: jest.fn((d: any, o: any) => ({ content: d.content, media_keys: [], targets: d.targets, scheduled_at: o.scheduled_at !== undefined ? o.scheduled_at : d.scheduled_at?.toISOString() ?? null, source: 'mcp' })),
    publish: jest.fn(async () => ({ id: 77, status: 'scheduled', scheduled_at: future(60), targets: [{ id: 1, account_name: 'Fanpage', status: 'queued' }] })),
  };
  const posts = {
    newSchedule: (at: unknown) => SocialPostsService.prototype.newSchedule.call({}, at),
    validate: jest.fn(async (_u: unknown, input: any) => ({
      content: input.content, media: [], scheduledAt: input.scheduled_at ? new Date(input.scheduled_at) : null,
      targets: input.targets.map((t: any) => ({ account: { id: t.account_id, name: 'Fanpage', network: 'facebook' }, caption: t.caption, options: t.options ?? {} })),
    })),
  };
  const accounts = { list: jest.fn(async () => [{ id: 3, name: 'Fanpage', network: 'facebook' }]) };
  return { social: { drafts, posts, accounts }, orgFeatures: { isEnabled: jest.fn(async () => true) } } as any;
}
const ctx = (d: any) => ({ deps: d, baseUrl: 'https://crm.example.com', principal: { user } }) as never;

describe('list_social_drafts', () => {
  it('trả nháp kèm tên kênh, giờ VN, captions dạng đầu vào và edit_url', async () => {
    const r = await listSocialDraftsTool.run({}, ctx(deps()));
    const d = (r.structured.data as any).drafts[0];
    expect(d).toMatchObject({
      draft_id: 4, title: 'Khuyến mãi', scheduled_at: '2026-10-20T09:00:00+07:00', edit_url: 'https://crm.example.com/social?tab=drafts&draft=4',
      channels: [{ account_id: 3, name: 'Fanpage', network: 'facebook' }], media: [{ media_key: 'social/u1_1_a.png', type: 'image', name: 'a.png' }],
    });
    expect(d.captions).toEqual([{ account_id: 3, caption: 'riêng', youtube_title: 'Tiêu đề', youtube_privacy: 'public', facebook_first_comment: 'Link' }]);
  });
});

describe('save_social_draft', () => {
  it('không có draft_id ⇒ tạo mới, nguồn mcp, nói rõ chưa đăng', async () => {
    const d = deps();
    const r = await saveSocialDraftTool.run({ content: 'Mới', account_ids: [3], captions: [{ account_id: 3, facebook_first_comment: 'Hi' }], scheduled_at: '2026-10-20T09:00' }, ctx(d));
    expect(d.social.drafts.create).toHaveBeenCalledWith(user, { content: 'Mới', targets: [{ account_id: 3, caption: null, options: { first_comment: 'Hi' } }], scheduled_at: '2026-10-20T02:00:00.000Z' }, 'mcp');
    expect(d.social.drafts.update).not.toHaveBeenCalled();
    expect((r.structured.data as any).next_step).toMatch(/CHƯA ĐĂNG/);
  });

  it('có draft_id ⇒ chỉ gửi trường đổi; captions không kèm account_ids giữ danh sách kênh và tuỳ chọn cũ', async () => {
    const d = deps();
    await saveSocialDraftTool.run({ draft_id: 4, title: 'Tên khác', captions: [{ account_id: 3, youtube_privacy: 'private' }] }, ctx(d));
    const [, id, input] = d.social.drafts.update.mock.calls[0];
    expect(id).toBe(4);
    expect(input).toEqual({ title: 'Tên khác', targets: [{ account_id: 3, caption: 'riêng', options: { title: 'Tiêu đề', privacy: 'private', first_comment: 'Link' } }] });
  });

  it('scheduled_at rỗng ⇒ xoá giờ hẹn; account_ids thay danh sách; caption lạc kênh ⇒ lỗi', async () => {
    const d = deps();
    await saveSocialDraftTool.run({ draft_id: 4, scheduled_at: '', account_ids: [] }, ctx(d));
    expect(d.social.drafts.update.mock.calls[0][2]).toEqual({ scheduled_at: null, targets: [] });
    await expect(saveSocialDraftTool.run({ draft_id: 4, account_ids: [5], captions: [{ account_id: 3, caption: 'x' }] }, ctx(deps()))).rejects.toThrow(/không nằm trong/);
  });

  it('lỗi 4xx của service thành lỗi người dùng; cần crm.write', async () => {
    const d = deps();
    d.social.drafts.update.mockRejectedValueOnce(Object.assign(new Error('Nháp này đã đăng'), { status: 409 }));
    await expect(saveSocialDraftTool.run({ draft_id: 4, content: 'x' }, ctx(d))).rejects.toThrow(/đã đăng/);
    expect(saveSocialDraftTool.scope).toBe('crm.write');
  });
});

describe('publish_social_draft', () => {
  const tool = actionToolByName('publish_social_draft')!;
  const actx = (d: any) => ({ deps: d, user }) as never;

  it('chưa có lời đồng ý ⇒ không đăng, hiện bản xem trước', async () => {
    await expect(tool.prepare({ draft_id: 4 }, actx(deps()))).rejects.toThrow(/Chưa đăng gì/);
  });

  it('chỉ lưu {draft_id} (không chụp nháp); giờ ghi đè chỉ có khi gửi', async () => {
    const d = deps();
    const p = await tool.prepare({ draft_id: 4, confirmed_by_user: 'ok đăng đi' }, actx(d));
    expect(p.params).toEqual({ draft_id: 4, version: expect.any(String) });
    expect(d.social.posts.validate).toHaveBeenCalled();
    const p2 = await tool.prepare({ draft_id: 4, scheduled_at: '', confirmed_by_user: 'ok đăng đi' }, actx(d));
    expect(p2.params).toEqual({ draft_id: 4, version: expect.any(String), scheduled_at: null });
    expect(p2.summary).toMatch(/Đăng ngay/);
  });

  it('execute gọi drafts.publish với giờ ghi đè và nguồn mcp', async () => {
    const d = deps();
    const r = await tool.execute({ draft_id: 4, version: '2026-10-15T08:00:00.000Z', scheduled_at: '2026-10-21T01:00:00.000Z' }, actx(d), 1);
    expect(d.social.drafts.publish).toHaveBeenCalledWith(user, 4, { scheduled_at: '2026-10-21T01:00:00.000Z' }, 'mcp', new Date('2026-10-15T08:00:00.000Z'));
    expect(r.post_id).toBe(77);
    await tool.execute({ draft_id: 4 }, actx(d), 1);
    expect(d.social.drafts.publish).toHaveBeenLastCalledWith(user, 4, {}, 'mcp', undefined);
  });

  it('giờ hẹn của nháp đã qua ⇒ báo ngay lúc chuẩn bị', async () => {
    const d = deps();
    d.social.drafts.get.mockResolvedValueOnce({ id: 4, content: 'x', targets: [{ account_id: 3 }], scheduled_at: new Date(Date.now() - 3_600_000) });
    await expect(tool.prepare({ draft_id: 4, confirmed_by_user: 'ok đăng đi' }, actx(d))).rejects.toThrow(/ít nhất 1 phút/);
  });

  it('nháp không có / lỗi kiểm ⇒ ActionUserError', async () => {
    const d = deps();
    d.social.drafts.get.mockRejectedValueOnce(Object.assign(new Error('Không tìm thấy bài nháp'), { status: 404 }));
    await expect(tool.prepare({ draft_id: 9, confirmed_by_user: 'ok đăng đi' }, actx(d))).rejects.toThrow(ActionUserError);
    d.social.posts.validate.mockRejectedValueOnce(Object.assign(new Error('Chọn ít nhất một kênh.'), { status: 400 }));
    await expect(tool.prepare({ draft_id: 4, confirmed_by_user: 'ok đăng đi' }, actx(d))).rejects.toThrow(/kênh/);
  });
});

describe('UTM — utm_campaign / utm_content', () => {
  const create = actionToolByName('create_social_post')!;
  const update = actionToolByName('update_scheduled_post')!;

  it('save_social_draft: chuyển thành input.utm; "" = bỏ; utm_content một mình bị từ chối', async () => {
    const d = deps();
    await saveSocialDraftTool.run({ content: 'x', account_ids: [3], utm_campaign: 'thu-2026', utm_content: 'a' }, ctx(d));
    expect(d.social.drafts.create.mock.calls[0][1].utm).toEqual({ campaign: 'thu-2026', content: 'a' });
    // nháp chưa có kênh ⇒ báo rõ, không mất UTM âm thầm
    await expect(saveSocialDraftTool.run({ content: 'x', utm_campaign: 'thu-2026' }, ctx(deps()))).rejects.toThrow(/chưa có kênh/);
    await saveSocialDraftTool.run({ draft_id: 4, utm_campaign: '' }, ctx(d));
    expect(d.social.drafts.update.mock.calls[0][2].utm).toBeNull();
    await expect(saveSocialDraftTool.run({ content: 'x', utm_content: 'a' }, ctx(deps()))).rejects.toThrow(/utm_campaign/);
  });
  it('list_social_drafts: trả utm_campaign lấy từ tuỳ chọn kênh', async () => {
    const r = await listSocialDraftsTool.run({}, ctx(deps(row({ targets: [{ account_id: 3, options: { utm: { campaign: 'c', content: 'k' } } }] }))));
    expect((r.structured.data as any).drafts[0]).toMatchObject({ utm_campaign: 'c', utm_content: 'k' });
  });
  it('create_social_post: có tham số, bản xem trước có dòng UTM, params mang utm', async () => {
    const d = deps();
    const p = await create.prepare({ content: 'Hi https://a.vn', account_ids: [3], utm_campaign: 'thu', confirmed_by_user: 'ok đăng đi' }, { deps: d, user } as never);
    expect(d.social.posts.validate.mock.calls[0][1].utm).toEqual({ campaign: 'thu' });
    expect((p.params as any).utm).toEqual({ campaign: 'thu' });
    // validate giả không tự gắn options.utm ⇒ dòng UTM chỉ hiện khi dịch vụ thật đã gắn
    const v = { content: 'x', media: [], scheduledAt: null, targets: [{ account: { id: 3, name: 'F', network: 'facebook' }, caption: null, options: { utm: { campaign: 'thu', content: 'a' } } }] };
    d.social.posts.validate.mockResolvedValueOnce(v);
    const p2 = await create.prepare({ content: 'x', account_ids: [3], utm_campaign: 'thu', utm_content: 'a', confirmed_by_user: 'ok đăng đi' }, { deps: d, user } as never);
    expect(p2.details.find((l: any) => l.label === 'UTM')?.value).toMatch(/campaign=thu, content=a/);
  });
  it('create_social_post: không utm ⇒ params.utm undefined', async () => {
    const d = deps();
    const p = await create.prepare({ content: 'Hi', account_ids: [3], confirmed_by_user: 'ok đăng đi' }, { deps: d, user } as never);
    expect((p.params as any).utm).toBeUndefined();
  });
  it('schema nhận utm_campaign/utm_content ở cả ba công cụ', () => {
    const z = require('zod');
    for (const t of [create, update]) expect(Object.keys(t.input(z))).toEqual(expect.arrayContaining(['utm_campaign', 'utm_content']));
    expect(Object.keys(saveSocialDraftTool.input(z))).toEqual(expect.arrayContaining(['utm_campaign', 'utm_content']));
  });
  void update;
});
