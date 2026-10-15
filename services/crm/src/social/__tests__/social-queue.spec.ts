import { BadRequestException } from '@nestjs/common';
import { SocialPostsService } from '../social-posts.service';
import { SocialQueueService, occurrences, slotAfter } from '../social-queue.service';

const MIN = 60_000;
/** Giờ Việt Nam → ms UTC. */
const vn = (iso: string) => Date.parse(`${iso}+07:00`);
// 2026-10-20 là Thứ Ba (weekday 2).
const TUE_8 = vn('2026-10-20T08:00:00');
const h = (hh: number, mm = 0) => hh * 60 + mm;

describe('slotAfter (giờ Việt Nam → UTC)', () => {
  it('khung muộn hơn trong ngày hôm nay', () => {
    expect(slotAfter({ weekday: 2, minute: h(9) }, TUE_8).toISOString()).toBe(new Date(vn('2026-10-20T09:00:00')).toISOString());
  });
  it('khung đã qua trong ngày ⇒ tuần sau', () => {
    expect(slotAfter({ weekday: 2, minute: h(7) }, TUE_8).getTime()).toBe(vn('2026-10-27T07:00:00'));
  });
  it('đúng giờ hiện tại thì lấy tuần sau (nghiêm ngặt "sau")', () => {
    expect(slotAfter({ weekday: 2, minute: h(8) }, TUE_8).getTime()).toBe(vn('2026-10-27T08:00:00'));
  });
  it('vòng qua cuối tuần: Thứ Ba → Chủ nhật, và Thứ Bảy → Thứ Hai', () => {
    expect(slotAfter({ weekday: 0, minute: h(10) }, TUE_8).getTime()).toBe(vn('2026-10-25T10:00:00'));
    expect(slotAfter({ weekday: 1, minute: h(10) }, vn('2026-10-24T23:00:00')).getTime()).toBe(vn('2026-10-26T10:00:00'));
  });
  it('23:30 giờ Việt Nam là 16:30 UTC cùng ngày; 00:30 là 17:30 UTC hôm trước', () => {
    expect(slotAfter({ weekday: 2, minute: h(23, 30) }, TUE_8).toISOString()).toBe('2026-10-20T16:30:00.000Z');
    expect(slotAfter({ weekday: 3, minute: h(0, 30) }, TUE_8).toISOString()).toBe('2026-10-20T17:30:00.000Z');
  });
  it('occurrences sắp theo thời gian và lặp theo tuần', () => {
    const o = occurrences([{ weekday: 4, minute: h(9) }, { weekday: 2, minute: h(19, 30) }], TUE_8, TUE_8 + 8 * 86_400_000);
    expect(o.map((d) => d.getTime())).toEqual([vn('2026-10-20T19:30:00'), vn('2026-10-22T09:00:00'), vn('2026-10-27T19:30:00')]);
  });
});

function setup(slots: Array<{ weekday: number; minute: number }>, taken: Date[] = []) {
  const tx = { socialQueueSlot: { deleteMany: jest.fn().mockResolvedValue({}), createMany: jest.fn().mockResolvedValue({}) } };
  const prisma = {
    socialQueueSlot: { findMany: jest.fn().mockResolvedValue(slots) },
    socialPost: { findMany: jest.fn().mockResolvedValue(taken.map((scheduled_at) => ({ scheduled_at }))) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
  };
  return { svc: new SocialQueueService(prisma as never), prisma, tx };
}

describe('SocialQueueService', () => {
  it('slots() sắp theo thứ rồi giờ', async () => {
    const { svc, prisma } = setup([{ weekday: 1, minute: 5 }]);
    await svc.slots();
    expect(prisma.socialQueueSlot.findMany.mock.calls[0][0].orderBy).toEqual([{ weekday: 'asc' }, { minute: 'asc' }]);
  });

  it('setSlots: thay trong transaction, bỏ trùng, sắp xếp', async () => {
    const { svc, tx } = setup([]);
    const r = await svc.setSlots([{ weekday: 3, minute: 600 }, { weekday: 1, minute: 60 }, { weekday: 3, minute: 600 }]);
    expect(r).toEqual([{ weekday: 1, minute: 60 }, { weekday: 3, minute: 600 }]);
    expect(tx.socialQueueSlot.deleteMany).toHaveBeenCalled();
    expect(tx.socialQueueSlot.createMany.mock.calls[0][0].data).toHaveLength(2);
  });

  it('setSlots: thứ/phút ngoài khoảng ⇒ 400; quá 100 khung ⇒ 400; rỗng thì xoá hết', async () => {
    const { svc, tx } = setup([]);
    await expect(svc.setSlots([{ weekday: 7, minute: 0 }])).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setSlots([{ weekday: 1, minute: 1440 }])).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setSlots([{ weekday: 1, minute: 1.5 }])).rejects.toBeInstanceOf(BadRequestException);
    const many = Array.from({ length: 101 }, (_, i) => ({ weekday: i % 7, minute: Math.floor(i / 7) }));
    await expect(svc.setSlots(many)).rejects.toThrow(/100/);
    expect(await svc.setSlots([])).toEqual([]);
    expect(tx.socialQueueSlot.createMany).not.toHaveBeenCalled();
  });

  it('nextFree: không có khung ⇒ rỗng, không đụng bảng bài', async () => {
    const { svc, prisma } = setup([]);
    expect(await svc.nextFree(3)).toEqual([]);
    expect(prisma.socialPost.findMany).not.toHaveBeenCalled();
  });

  it('nextFree: lấy count khung gần nhất, bỏ khung < now + 2 phút', async () => {
    const { svc } = setup([{ weekday: 2, minute: h(9) }, { weekday: 3, minute: h(9) }]);
    // 08:58 → 09:00 chỉ cách 2 phút (không "strictly after" +2) ⇒ nhảy khung sau
    const r = await svc.nextFree(2, vn('2026-10-20T08:59:00'));
    expect(r.map((d) => d.getTime())).toEqual([vn('2026-10-21T09:00:00'), vn('2026-10-27T09:00:00')]);
    const r2 = await svc.nextFree(1, vn('2026-10-20T08:57:00'));
    expect(r2[0].getTime()).toBe(vn('2026-10-20T09:00:00'));
  });

  it('nextFree: bỏ khung đã có bài hẹn trong cùng phút', async () => {
    const { svc } = setup([{ weekday: 2, minute: h(9) }], [new Date(vn('2026-10-20T09:00:30'))]);
    const r = await svc.nextFree(2, TUE_8);
    expect(r.map((d) => d.getTime())).toEqual([vn('2026-10-27T09:00:00'), vn('2026-11-03T09:00:00')]);
  });

  it('nextFree: không vượt 90 ngày', async () => {
    const { svc } = setup([{ weekday: 2, minute: h(9) }]);
    const r = await svc.nextFree(50, TUE_8);
    expect(r.length).toBe(13);
    expect(r[r.length - 1].getTime() - TUE_8).toBeLessThanOrEqual(90 * 86_400_000);
  });
});

describe('SocialPostsService.create với use_queue', () => {
  function posts(queue: { nextFree: jest.Mock } | undefined) {
    const svc = new SocialPostsService({} as never, {} as never, {} as never, {} as never, queue as never);
    const validate = jest.spyOn(svc, 'validate').mockRejectedValue(new Error('stop'));
    return { svc, validate };
  }
  const user = { userId: 1 } as never;
  const input = { content: 'x', targets: [{ account_id: 1 }] };

  it('không có khung ⇒ 400 với thông báo hướng dẫn', async () => {
    const { svc } = posts({ nextFree: jest.fn().mockResolvedValue([]) });
    await expect(svc.create(user, { ...input, use_queue: true })).rejects.toThrow(/Chưa đặt khung giờ hàng đợi/);
  });

  it('có khung ⇒ validate nhận scheduled_at là khung đó', async () => {
    const slot = new Date(Date.now() + 3_600_000);
    const { svc, validate } = posts({ nextFree: jest.fn().mockResolvedValue([slot]) });
    await expect(svc.create(user, { ...input, use_queue: true })).rejects.toThrow('stop');
    expect(validate.mock.calls[0][1].scheduled_at).toBe(slot.toISOString());
  });

  it('gửi cả use_queue và scheduled_at ⇒ 400, không hỏi hàng đợi', async () => {
    const nextFree = jest.fn();
    const { svc } = posts({ nextFree });
    await expect(svc.create(user, { ...input, use_queue: true, scheduled_at: '2030-01-01T00:00:00Z' })).rejects.toThrow(/Chỉ chọn một/);
    expect(nextFree).not.toHaveBeenCalled();
  });
});
