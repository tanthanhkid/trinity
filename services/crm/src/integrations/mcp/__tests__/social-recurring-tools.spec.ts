import { actionToolByName } from '../actions/action-registry';
import { ActionUserError } from '../actions/action-types';
import { describeRule } from '../actions/action-recurring-tools';
import { MCP_TOOLS } from '../mcp-tools.registry';
import { listRecurringPostsTool } from '../tools/social-tools';

const user = { userId: 1, email: 'a@x.vn', isAdmin: true, grants: {} } as never;
const T1 = new Date('2026-10-20T02:00:00Z'); // 09:00 Thứ Ba giờ VN
const T2 = new Date('2026-10-27T02:00:00Z');
const rule = { freq: 'weekly', interval: 1, weekdays: [2], time: '09:00' };
const template = { content: 'Chào tuần mới', media_keys: [], targets: [{ account_id: 3 }] };
const view = (over: Record<string, unknown> = {}) => ({
  id: 4, title: 'Tuần mới', template, rule, starts_on: '2026-10-01', ends_on: null, max_count: null, count: 2, next_run_at: T2.toISOString(), active: true, last_error: null,
  created_by: 1, next_times: [T1.toISOString(), T2.toISOString()], posts: [{ id: 9, status: 'scheduled', scheduled_at: T1.toISOString() }], ...over,
});

function deps(over: Record<string, unknown> = {}) {
  const recurrences = {
    list: jest.fn(async () => [view(), view({ id: 5, active: false, last_error: 'Kênh "A" cần liên kết lại trước khi đăng.', next_times: [] })]),
    get: jest.fn(async () => view()),
    preview: jest.fn(async (_u: unknown, input: any) => ({
      title: input.title ?? 'Tuần mới', rule: { ...rule, ...(input.rule ?? {}) }, startsOn: '2026-10-20', endsOn: null, maxCount: null, times: [T1, T2],
      validated: { content: input.template?.content ?? 'Chào tuần mới', media: [], scheduledAt: null, targets: [{ account: { id: 3, name: 'Fanpage', network: 'facebook' }, caption: null, options: {} }] },
    })),
    create: jest.fn(async () => view()),
    update: jest.fn(async () => view()),
    pause: jest.fn(async () => view({ active: false, next_times: [] })),
    resume: jest.fn(async () => view()),
    ...over,
  };
  return { social: { recurrences, posts: {}, queue: {}, drafts: {}, accounts: {}, snippets: {}, importer: {} }, orgFeatures: { isEnabled: jest.fn(async () => true) } } as any;
}
const actx = (d: any) => ({ deps: d, user }) as never;
const create = actionToolByName('create_recurring_post')!;
const update = actionToolByName('update_recurring_post')!;
const toggle = actionToolByName('set_recurring_post_active')!;
const base = { account_ids: [3], content: 'Chào tuần mới', freq: 'weekly', weekdays: [2], time: '09:00', starts_on: '2026-10-20' };

describe('đăng ký tool', () => {
  it('4 tool có mặt, không có tool xoá, mô tả cả Việt lẫn Anh', () => {
    const names = ['list_recurring_posts', 'create_recurring_post', 'update_recurring_post', 'set_recurring_post_active'];
    for (const n of names) {
      const t = MCP_TOOLS.find((x) => x.name === n)!;
      expect(t).toBeDefined();
      expect(t.description).toMatch(/\//);
      expect(t.permissions).toEqual(['social.post']);
    }
    expect(MCP_TOOLS.some((t) => /delete|remove|xoa/i.test(t.name) && /recurr/.test(t.name))).toBe(false);
    expect(MCP_TOOLS.find((x) => x.name === 'list_recurring_posts')!.scope).toBeUndefined();
    expect(MCP_TOOLS.find((x) => x.name === 'create_recurring_post')!.scope).toBe('crm.write');
  });
  it('describeRule', () => {
    expect(describeRule({ freq: 'weekly', interval: 2, weekdays: [1, 4], time: '09:00' })).toBe('Hằng tuần, mỗi 2 tuần vào Thứ Hai, Thứ Năm lúc 09:00 (giờ Việt Nam)');
    expect(describeRule({ freq: 'monthly', interval: 1, month_day: 31, time: '08:30' })).toBe('Hằng tháng vào ngày 31 lúc 08:30 (giờ Việt Nam)');
    expect(describeRule({ freq: 'daily', interval: 1, time: '07:00' })).toBe('Hằng ngày lúc 07:00 (giờ Việt Nam)');
  });
});

describe('list_recurring_posts', () => {
  it('trạng thái, luật, 3 lần tới theo giờ VN, lỗi và bài gần nhất', async () => {
    const r = await listRecurringPostsTool.run({}, { deps: deps(), baseUrl: 'https://crm.example.com', principal: { user } } as never);
    const d = (r.structured.data as any).recurrences;
    expect(d[0]).toMatchObject({ recurrence_id: 4, status: 'active', rule: 'Hằng tuần vào Thứ Ba lúc 09:00 (giờ Việt Nam)', posts_created: 2, account_ids: [3] });
    expect(d[0].next_times[0]).toBe('09:00 Thứ Ba 20/10/2026 (giờ Việt Nam)');
    expect(d[1]).toMatchObject({ status: 'paused', last_error: expect.stringContaining('liên kết lại') });
  });
});

describe('create_recurring_post', () => {
  it('thiếu confirmed_by_user ⇒ lỗi kèm bản xem trước (luật + 3 lần tới), chưa ghi gì', async () => {
    const d = deps();
    const err: Error = await create.prepare(base, actx(d)).then(() => new Error('không ném'), (e) => e);
    expect(err).toBeInstanceOf(ActionUserError);
    expect(err.message).toMatch(/Chưa đăng gì/);
    expect(err.message).toMatch(/Hằng tuần vào Thứ Ba lúc 09:00/);
    expect(err.message).toMatch(/09:00 Thứ Ba 20\/10\/2026/);
    expect(err.message).toMatch(/Fanpage/);
    expect(d.social.recurrences.create).not.toHaveBeenCalled();
  });
  it('lời yêu cầu thường không phải đồng ý', async () => {
    await expect(create.prepare({ ...base, confirmed_by_user: 'đăng bài lặp lại hằng tuần cho fanpage' }, actx(deps()))).rejects.toThrow(/Chưa đăng gì/);
  });
  it('có đồng ý ⇒ chuẩn bị đầu vào và execute gọi create', async () => {
    const d = deps();
    const p = await create.prepare({ ...base, captions: [{ account_id: 3, caption: 'riêng' }], utm_campaign: 'tuan-moi', max_count: 5, confirmed_by_user: 'ok đăng đi' }, actx(d));
    const input = (p.params as any).input;
    expect(input).toMatchObject({ rule: { freq: 'weekly', weekdays: [2], time: '09:00' }, starts_on: '2026-10-20', max_count: 5, ends_on: null });
    expect(input.template.targets[0]).toMatchObject({ account_id: 3, caption: 'riêng' });
    expect(input.template.utm).toEqual({ campaign: 'tuan-moi' });
    expect(p.details!.some((x) => x.label === '3 lần đăng tới')).toBe(true);
    expect(p.details!.some((x) => x.label === 'Giờ đăng')).toBe(false);
    const r: any = await create.execute(p.params, actx(d), 1);
    expect(d.social.recurrences.create).toHaveBeenCalledWith(user, input);
    expect(r).toMatchObject({ recurrence_id: 4, status: 'active', upcoming_post_id: 9 });
  });
  it('lỗi 400 của service thành lỗi AI sửa được', async () => {
    const d = deps({ preview: jest.fn().mockRejectedValue(Object.assign(new Error('Chọn ít nhất một kênh.'), { status: 400 })) });
    await expect(create.prepare({ ...base, confirmed_by_user: 'ok đăng đi' }, actx(d))).rejects.toBeInstanceOf(ActionUserError);
  });
});

describe('update_recurring_post', () => {
  it('chỉ lưu PHẦN SỬA; execute ghép lại với lịch hiện tại rồi gọi update', async () => {
    const d = deps();
    const p = await update.prepare({ recurrence_id: 4, time: '10:30', content: 'Nội dung mới', confirmed_by_user: 'ok sửa đi' }, actx(d));
    expect(p.params).toEqual({ recurrence_id: 4, patch: { content: 'Nội dung mới', rule: { time: '10:30' } } });
    await update.execute(p.params, actx(d), 1);
    const [, id, input] = d.social.recurrences.update.mock.calls[0];
    expect(id).toBe(4);
    expect(input.template).toMatchObject({ content: 'Nội dung mới', targets: [{ account_id: 3 }] });
    expect(input.rule).toEqual({ time: '10:30' });
    expect(input.title).toBe('Tuần mới');
  });
  it('ends_on "" và max_count 0 = bỏ giới hạn', async () => {
    const d = deps();
    const p = await update.prepare({ recurrence_id: 4, ends_on: '', max_count: 0, confirmed_by_user: 'ok sửa đi' }, actx(d));
    expect((p.params as any).patch).toMatchObject({ ends_on: null, max_count: null });
  });
  it('thiếu confirmed_by_user ⇒ không ghi', async () => {
    const d = deps();
    await expect(update.prepare({ recurrence_id: 4, time: '10:30' }, actx(d))).rejects.toThrow(/Chưa đăng gì/);
    expect(d.social.recurrences.update).not.toHaveBeenCalled();
  });
});

describe('set_recurring_post_active', () => {
  it('tạm dừng: không cần xác nhận', async () => {
    const d = deps();
    const p = await toggle.prepare({ recurrence_id: 4, active: false }, actx(d));
    expect(p.summary).toMatch(/Tạm dừng/);
    const r: any = await toggle.execute(p.params, actx(d), 1);
    expect(d.social.recurrences.pause).toHaveBeenCalledWith(4);
    expect(r.status).toBe('paused');
  });
  it('tiếp tục: cần confirmed_by_user và nêu các lần đăng tới', async () => {
    const d = deps();
    const err: Error = await toggle.prepare({ recurrence_id: 4, active: true }, actx(d)).then(() => new Error('không ném'), (e) => e);
    expect(err.message).toMatch(/Chưa đăng gì/);
    expect(err.message).toMatch(/3 lần đăng tới/);
    const p = await toggle.prepare({ recurrence_id: 4, active: true, confirmed_by_user: 'ok tiếp tục đi' }, actx(d));
    await toggle.execute(p.params, actx(d), 1);
    expect(d.social.recurrences.resume).toHaveBeenCalledWith(4);
  });
  it('thiếu active ⇒ lỗi', async () => {
    await expect(toggle.prepare({ recurrence_id: 4 }, actx(deps()))).rejects.toThrow(/active/);
  });
});
