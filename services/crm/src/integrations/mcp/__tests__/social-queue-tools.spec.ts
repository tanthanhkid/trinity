import { actionToolByName } from '../actions/action-registry';
import { ActionUserError } from '../actions/action-types';
import { listQueueSlotsTool, setQueueSlotsTool } from '../tools/social-tools';

const user = { userId: 1, email: 'a@x.vn', isAdmin: true, grants: {} } as never;
const SLOT = new Date('2026-10-20T02:00:00Z'); // 09:00 Thứ Ba giờ Việt Nam
const NOW = new Date('2026-10-15T03:00:00Z');

function deps(slots: Array<{ weekday: number; minute: number }> = [{ weekday: 2, minute: 540 }], next: Date[] = [SLOT]) {
  const queue = {
    slots: jest.fn(async () => slots),
    nextFree: jest.fn(async () => next),
    isFree: jest.fn(async () => true),
    setSlots: jest.fn(async (l: Array<{ weekday: number; minute: number }>) => l),
  };
  const posts = {
    validate: jest.fn(async (_u: unknown, input: any) => ({
      content: input.content, media: [], scheduledAt: input.scheduled_at ? new Date(input.scheduled_at) : null,
      targets: input.targets.map((t: any) => ({ account: { id: t.account_id, name: 'Fanpage', network: 'facebook' }, caption: t.caption, options: t.options ?? {} })),
    })),
    newSchedule: jest.fn(),
    create: jest.fn(async (_u: unknown, input: any) => ({ id: 77, status: 'scheduled', scheduled_at: new Date(input.scheduled_at), targets: [] })),
  };
  const drafts = {
    publish: jest.fn(async () => ({ id: 78, status: 'scheduled', scheduled_at: SLOT, targets: [] })),
    get: jest.fn(async () => ({ id: 4, content: 'x', targets: [{ account_id: 3 }], scheduled_at: null, updated_at: NOW })),
    toPostInput: jest.fn((d: any, o: any) => ({ content: d.content, media_keys: [], targets: d.targets, scheduled_at: o.scheduled_at ?? null, use_queue: o.scheduled_at === undefined && d.use_queue ? true : undefined, source: 'mcp' })),
  };
  return { social: { queue, posts, drafts, accounts: {} }, orgFeatures: { isEnabled: jest.fn(async () => true) } } as any;
}
const ctx = (d: any) => ({ deps: d, baseUrl: 'https://crm.example.com', principal: { user } }) as never;
const actx = (d: any) => ({ deps: d, user }) as never;

describe('list_queue_slots', () => {
  it('trả khung kèm thứ bằng chữ, giờ HH:mm và next_free', async () => {
    const r = await listQueueSlotsTool.run({}, ctx(deps([{ weekday: 1, minute: 570 }, { weekday: 6, minute: 1170 }])));
    const d = r.structured.data as any;
    expect(d.slots).toEqual([{ weekday: 1, weekday_text: 'Thứ Hai', time: '09:30' }, { weekday: 6, weekday_text: 'Thứ Bảy', time: '19:30' }]);
    expect(d.next_free).toEqual(['09:00 Thứ Ba 20/10/2026 (giờ Việt Nam)']);
  });
  it('quyền social.post, chỉ đọc', () => {
    expect(listQueueSlotsTool.permissions).toEqual(['social.post']);
    expect(listQueueSlotsTool.scope).toBeUndefined();
  });
});

describe('set_queue_slots', () => {
  it('đổi HH:mm thành phút và gọi setSlots; scope crm.write', async () => {
    const d = deps();
    const r = await setQueueSlotsTool.run({ slots: [{ weekday: 1, time: '09:00' }, { weekday: 1, time: '19:30' }] }, ctx(d));
    expect(d.social.queue.setSlots).toHaveBeenCalledWith([{ weekday: 1, minute: 540 }, { weekday: 1, minute: 1170 }]);
    expect((r.structured.data as any).slots[1]).toEqual({ weekday: 1, weekday_text: 'Thứ Hai', time: '19:30' });
    expect(setQueueSlotsTool.scope).toBe('crm.write');
    expect(setQueueSlotsTool.description).toMatch(/thay|Replaces/);
  });
  it('lỗi 400 của service thành lỗi AI sửa được', async () => {
    const d = deps();
    d.social.queue.setSlots.mockRejectedValueOnce(Object.assign(new Error('Tối đa 100 khung giờ.'), { status: 400 }));
    await expect(setQueueSlotsTool.run({ slots: [{ weekday: 1, time: '09:00' }] }, ctx(d))).rejects.toThrow(/100/);
  });

  it('danh sách rỗng ⇒ từ chối (không xoá lịch cả công ty qua AI)', async () => {
    const d = deps();
    await expect(setQueueSlotsTool.run({ slots: [] }, ctx(d))).rejects.toThrow(/ít nhất một khung/);
    expect(d.social.queue.setSlots).not.toHaveBeenCalled();
  });
});

describe('use_queue trong create_social_post / publish_social_draft', () => {
  const create = actionToolByName('create_social_post')!;
  const publish = actionToolByName('publish_social_draft')!;
  const args = { content: 'Hi', account_ids: [3], confirmed_by_user: 'ok đăng đi' };

  it('create: đổi thành giờ cụ thể, bản xem trước và tham số đã lưu cùng giờ', async () => {
    const d = deps();
    const p = await create.prepare({ ...args, use_queue: true }, actx(d));
    expect(d.social.posts.validate.mock.calls[0][1].scheduled_at).toBe(SLOT.toISOString());
    expect((p.params as any).scheduled_at).toBe(SLOT.toISOString());
    expect((p.params as any).use_queue).toBeUndefined();
    expect(p.summary).toMatch(/09:00 Thứ Ba 20\/10\/2026/);
  });
  it('create: cả use_queue lẫn scheduled_at ⇒ lỗi; không có khung ⇒ lỗi hướng dẫn', async () => {
    await expect(create.prepare({ ...args, use_queue: true, scheduled_at: '2026-10-21T09:00' }, actx(deps()))).rejects.toThrow(/một trong/);
    await expect(create.prepare({ ...args, use_queue: true }, actx(deps([], [])))).rejects.toThrow(ActionUserError);
    await expect(create.prepare({ ...args, use_queue: true }, actx(deps([], [])))).rejects.toThrow(/Khung giờ/);
  });
  it('create không use_queue ⇒ không hỏi hàng đợi', async () => {
    const d = deps();
    await create.prepare(args, actx(d));
    expect(d.social.queue.nextFree).not.toHaveBeenCalled();
  });
  it('publish nháp: lưu giờ cụ thể làm giờ ghi đè', async () => {
    const d = deps();
    const p = await publish.prepare({ draft_id: 4, use_queue: true, confirmed_by_user: 'ok đăng đi' }, actx(d));
    expect(p.params).toEqual({ draft_id: 4, version: NOW.toISOString(), scheduled_at: SLOT.toISOString(), queued: true });
    expect(p.summary).toMatch(/09:00 Thứ Ba/);
  });
  it('publish nháp: use_queue + scheduled_at ⇒ lỗi', async () => {
    await expect(publish.prepare({ draft_id: 4, use_queue: true, scheduled_at: '2026-10-21T09:00', confirmed_by_user: 'ok đăng đi' }, actx(deps()))).rejects.toThrow(/một trong/);
  });
});

describe('khung hàng đợi lúc chạy đề xuất đã duyệt', () => {
  const create = actionToolByName('create_social_post')!;
  const publish = actionToolByName('publish_social_draft')!;
  const LATER = new Date('2026-10-22T12:30:00Z');

  it('khung còn trống ⇒ đăng đúng giờ đã xem; khung đã bị chiếm/qua ⇒ dời sang khung kế và báo moved_from', async () => {
    const d = deps();
    const p = await create.prepare({ content: 'Hi', account_ids: [3], use_queue: true, confirmed_by_user: 'ok đăng đi' }, actx(d));
    expect((p.params as any).queued).toBe(true);
    await create.execute(p.params, actx(d), 1);
    expect(d.social.posts.create.mock.calls[0][1]).toMatchObject({ scheduled_at: SLOT.toISOString(), source: 'mcp' });
    expect('queued' in d.social.posts.create.mock.calls[0][1]).toBe(false);
    d.social.queue.isFree.mockResolvedValueOnce(false);
    d.social.queue.nextFree.mockResolvedValueOnce([LATER]);
    const r = await create.execute(p.params, actx(d), 2);
    expect(d.social.posts.create.mock.calls[1][1].scheduled_at).toBe(LATER.toISOString());
    expect(r.moved_from).toMatch(/09:00 Thứ Ba/);
  });

  it('giờ cụ thể (không qua hàng đợi) ⇒ không kiểm khung lúc chạy', async () => {
    const d = deps();
    const p = await create.prepare({ content: 'Hi', account_ids: [3], scheduled_at: '2026-10-21T09:00', confirmed_by_user: 'ok đăng đi' }, actx(d));
    await create.execute(p.params, actx(d), 1);
    expect(d.social.queue.isFree).not.toHaveBeenCalled();
  });

  it('nháp tự chọn "Vào hàng đợi" ⇒ xem trước chốt khung cụ thể, lúc chạy kiểm lại', async () => {
    const d = deps();
    d.social.drafts.get.mockResolvedValue({ id: 4, content: 'x', targets: [{ account_id: 3 }], scheduled_at: null, use_queue: true, updated_at: NOW });
    const p = await publish.prepare({ draft_id: 4, confirmed_by_user: 'ok đăng đi' }, actx(d));
    expect(p.params).toEqual({ draft_id: 4, version: NOW.toISOString(), scheduled_at: SLOT.toISOString(), queued: true });
    expect(p.summary).toMatch(/09:00 Thứ Ba/);
    d.social.queue.isFree.mockResolvedValueOnce(false);
    d.social.queue.nextFree.mockResolvedValueOnce([LATER]);
    const r = await publish.execute(p.params, actx(d), 1);
    expect(d.social.drafts.publish).toHaveBeenCalledWith(user, 4, { scheduled_at: LATER.toISOString() }, 'mcp', NOW);
    expect(r.moved_from).toBeDefined();
  });
});
