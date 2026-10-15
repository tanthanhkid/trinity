import { BadRequestException } from '@nestjs/common';
import { cleanAudience, FacebookBroadcastsService } from '../facebook-broadcasts.service';
import { GraphApiError } from '../graph-client';

type Row = Record<string, any>;

/** So một dòng với `where` kiểu Prisma (đủ cho các truy vấn của FacebookBroadcastsService). */
function match(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => match(row, w));
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return v.in.includes(row[k]);
      if ('gte' in v) return row[k] !== null && row[k] >= v.gte;
      if ('lte' in v) return row[k] !== null && row[k] <= v.lte;
      if ('lt' in v) return row[k] !== null && row[k] < v.lt;
    }
    return row[k] === v;
  });
}

function table(rows: Row[] = [], defaults: Row = {}) {
  let seq = rows.reduce((m, r) => Math.max(m, r.id ?? 0), 0);
  const apply = (r: Row, data: Row) => {
    for (const [k, v] of Object.entries(data)) r[k] = v && typeof v === 'object' && !(v instanceof Date) && 'increment' in v ? (r[k] ?? 0) + v.increment : v;
  };
  return {
    rows,
    findMany: async ({ where, take }: Row = {}) => rows.filter((r) => match(r, where)).slice(0, take ?? Infinity),
    findFirst: async ({ where }: Row = {}) => rows.find((r) => match(r, where)) ?? null,
    findUnique: async ({ where }: Row) => rows.find((r) => r.id === where.id) ?? null,
    count: async ({ where }: Row = {}) => rows.filter((r) => match(r, where)).length,
    create: async ({ data }: Row) => {
      const r = { id: ++seq, created_at: new Date(), ...defaults, ...data };
      rows.push(r);
      return r;
    },
    createMany: async ({ data }: Row) => {
      for (const d of data) rows.push({ id: ++seq, status: 'queued', note: null, claimed_at: null, sent_at: null, ...d });
      return { count: data.length };
    },
    update: async ({ where, data }: Row) => {
      const r = rows.find((x) => x.id === where.id)!;
      apply(r, data);
      return r;
    },
    updateMany: async ({ where, data }: Row) => {
      const hit = rows.filter((r) => match(r, where));
      hit.forEach((r) => apply(r, data));
      return { count: hit.length };
    },
    delete: async ({ where }: Row) => rows.splice(rows.findIndex((r) => r.id === where.id), 1)[0],
    deleteMany: async ({ where }: Row) => {
      const keep = rows.filter((r) => !match(r, where));
      const n = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { count: n };
    },
  };
}

const NOW = Date.UTC(2026, 9, 14, 8, 0, 0);
const ago = (min: number) => new Date(NOW - min * 60_000);

function setup() {
  const prisma: any = {
    facebookPage: table([{ id: 1, page_id: 'P', name: 'Trang A', is_active: true }]),
    facebookBroadcast: table([], { status: 'draft', scheduled_at: null, total: 0, sent: 0, failed: 0, skipped: 0, started_at: null, finished_at: null }),
    facebookBroadcastRecipient: table(),
    facebookConversation: table([
      { id: 1, page_id: 'P', psid: 'U1', customer_name: 'Lan', contact_id: 11, entry_link_id: 4, last_inbound_at: ago(30) },
      { id: 2, page_id: 'P', psid: 'U2', customer_name: 'Minh', contact_id: 12, entry_link_id: null, last_inbound_at: ago(60 * 20) },
      { id: 3, page_id: 'P', psid: 'U3', customer_name: 'Cũ', contact_id: 13, entry_link_id: 4, last_inbound_at: ago(60 * 30) },
      { id: 4, page_id: 'Q', psid: 'U4', customer_name: 'Trang khác', contact_id: null, entry_link_id: null, last_inbound_at: ago(5) },
    ]),
    contact: table([
      { id: 11, source_id: 7 },
      { id: 12, source_id: 8 },
      { id: 13, source_id: 7 },
    ]),
    facebookMessage: table(),
    activity: table(),
    integrationEvent: table(),
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  };
  const graph = { sendText: jest.fn(async (_t: string, psid: string) => ({ message_id: `m-${psid}` })) };
  const pages = { activePageWithToken: jest.fn(async () => ({ token: 'tok' })), markTokenInvalid: jest.fn(async () => undefined) };
  const svc = new FacebookBroadcastsService(prisma, graph as any, pages as any);
  return { svc, prisma, graph, pages };
}

describe('gửi tin hàng loạt', () => {
  beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] }));
  afterEach(() => jest.useRealTimers());

  it('cleanAudience: bỏ id rác, trùng, rỗng', () => {
    expect(cleanAudience({ source_ids: [7, '7', -1, 'x'], chat_link_ids: [] })).toEqual({ source_ids: [7] });
    expect(cleanAudience(null)).toEqual({});
  });

  it('preview: chỉ đếm khách còn trong 24h; lọc nguồn / link; báo số khách quá 24h', async () => {
    const { svc } = setup();
    expect(await svc.preview('P', {}, NOW)).toEqual({ eligible: 2, outside_window: 1, sample: ['Lan', 'Minh'] });
    expect(await svc.preview('P', { source_ids: [7] }, NOW)).toMatchObject({ eligible: 1, outside_window: 1, sample: ['Lan'] });
    expect(await svc.preview('P', { chat_link_ids: [4] }, NOW)).toMatchObject({ eligible: 1, outside_window: 1 });
    await expect(svc.preview('ZZ', {}, NOW)).rejects.toThrow(BadRequestException);
  });

  it('tạo → gửi → chạy nền: gửi khách trong 24h, ghi hộp thư + lịch sử khách, kết thúc done', async () => {
    const { svc, prisma, graph } = setup();
    const b = await svc.create({ name: 'Khai giảng', page_id: 'P', text: 'Chào {ten}, lớp mới mở' }, 5, 'mcp');
    expect(b.status).toBe('draft');
    await svc.send(b.id, null, NOW);
    const r = await svc.runDue(5_000, NOW);
    expect(r).toMatchObject({ started: 1, sent: 2, failed: 0, skipped: 0 });
    expect(graph.sendText).toHaveBeenCalledWith('tok', 'U1', 'Chào Lan, lớp mới mở');
    const done = await svc.get(b.id);
    expect(done).toMatchObject({ status: 'done', total: 2, sent: 2, source: 'mcp' });
    expect(prisma.facebookMessage.rows).toHaveLength(2);
    expect(prisma.activity.rows[0]).toMatchObject({ contact_id: 11, created_by: 5, metadata: { broadcast_id: b.id } });
    // Webhook ra ngoài: mỗi tin một messenger.message_sent (origin broadcast) + một broadcast_finished.
    const evs = prisma.integrationEvent.rows.map((e: Row) => [e.event_type, e.payload.origin ?? e.payload.status]);
    expect(evs).toEqual([['messenger.message_sent', 'broadcast'], ['messenger.message_sent', 'broadcast'], ['messenger.broadcast_finished', 'done']]);
    // Chạy lại không gửi trùng.
    expect(await svc.runDue(5_000, NOW)).toMatchObject({ started: 0, sent: 0 });
    expect(graph.sendText).toHaveBeenCalledTimes(2);
  });

  it('sửa bộ lọc ngay trước lúc chốt (bản liệt kê đã cũ) ⇒ người nhận theo bộ lọc MỚI; dời giờ thì chưa chốt', async () => {
    const { svc, prisma } = setup();
    const b = await svc.create({ name: 'x', page_id: 'P', text: 'hi', audience: { source_ids: [8] } }, 1);
    await svc.send(b.id, null, NOW);
    const stale = { ...prisma.facebookBroadcast.rows.find((r: Row) => r.id === b.id) };
    await svc.update(b.id, { audience: { source_ids: [7] } });
    expect(await (svc as any).start(stale, NOW)).toBe(true);
    expect(prisma.facebookBroadcastRecipient.rows.map((r: Row) => r.conversation_id)).toEqual([1]);
    // Lượt khác: bị dời sang giờ sau lúc liệt kê ⇒ không chốt.
    const c = await svc.create({ name: 'y', page_id: 'P', text: 'hi' }, 1);
    await svc.send(c.id, null, NOW);
    const staleC = { ...prisma.facebookBroadcast.rows.find((r: Row) => r.id === c.id) };
    await svc.send(c.id, new Date(NOW + 3_600_000).toISOString(), NOW);
    expect(await (svc as any).start(staleC, NOW)).toBe(false);
  });

  it('khách hết 24h giữa lúc chốt và lúc gửi ⇒ bỏ qua, không gọi Facebook', async () => {
    const { svc, prisma, graph } = setup();
    const b = await svc.create({ name: 'x', page_id: 'P', text: 'hi', audience: { source_ids: [8] } }, 1);
    await svc.send(b.id, null, NOW);
    expect(await svc.runDue(0, NOW)).toMatchObject({ started: 1, sent: 0 }); // budget 0: chốt người nhận, chưa gửi
    prisma.facebookConversation.rows[1].last_inbound_at = ago(60 * 25);
    await svc.runDue(5_000, NOW);
    expect(graph.sendText).not.toHaveBeenCalled();
    expect(await svc.get(b.id)).toMatchObject({ status: 'done', total: 1, skipped: 1 });
  });

  it('không ai trong 24h ⇒ xong luôn với 0 người nhận', async () => {
    const { svc } = setup();
    const b = await svc.create({ name: 'x', page_id: 'P', text: 'hi', audience: { source_ids: [999] } }, 1);
    await svc.send(b.id, null, NOW);
    await svc.runDue(5_000, NOW);
    expect(await svc.get(b.id)).toMatchObject({ status: 'done', total: 0 });
  });

  it('token hỏng ⇒ đánh dấu Page, phần còn lại báo lỗi, không thử từng người', async () => {
    const { svc, graph, pages } = setup();
    graph.sendText.mockRejectedValueOnce(new GraphApiError(400, 190, null, 'expired'));
    const b = await svc.create({ name: 'x', page_id: 'P', text: 'hi' }, 1);
    await svc.send(b.id, null, NOW);
    await svc.runDue(5_000, NOW);
    expect(pages.markTokenInvalid).toHaveBeenCalledWith('P');
    expect(graph.sendText).toHaveBeenCalledTimes(1);
    expect(await svc.get(b.id)).toMatchObject({ status: 'done', failed: 2, sent: 0 });
  });

  it('hẹn giờ: chưa tới giờ không chạy; quá 7 ngày ⇒ lỗi; huỷ trước giờ ⇒ cancelled', async () => {
    const { svc, graph } = setup();
    const b = await svc.create({ name: 'x', page_id: 'P', text: 'hi' }, 1);
    await expect(svc.send(b.id, new Date(NOW + 8 * 86_400_000).toISOString(), NOW)).rejects.toThrow(/7 ngày/);
    await svc.send(b.id, new Date(NOW + 3_600_000).toISOString(), NOW);
    expect(await svc.runDue(5_000, NOW)).toMatchObject({ started: 0 });
    await expect(svc.remove(b.id)).rejects.toThrow(/Huỷ/);
    expect((await svc.cancel(b.id)).status).toBe('cancelled');
    expect(await svc.runDue(5_000, NOW + 2 * 3_600_000)).toMatchObject({ started: 0 });
    expect(graph.sendText).not.toHaveBeenCalled();
    await svc.remove(b.id);
    await expect(svc.get(b.id)).rejects.toThrow();
  });

  it('kickIfDue: có lượt tới giờ ⇒ chạy nền và gửi; kiểm DB tối đa mỗi 20 giây', async () => {
    const { svc, graph } = setup();
    expect(await svc.kickIfDue(NOW)).toEqual({ due: false });
    const b = await svc.create({ name: 'x', page_id: 'P', text: 'hi' }, 1);
    await svc.send(b.id, null, NOW);
    expect(await svc.kickIfDue(NOW + 5_000)).toEqual({ due: false }); // chưa đủ 20 giây
    expect(await svc.kickIfDue(NOW + 25_000)).toEqual({ due: true });
    await new Promise((r) => setImmediate(r));
    await jest.runAllTimersAsync?.();
    for (let i = 0; i < 20 && (await svc.get(b.id)).status !== 'done'; i++) await new Promise((r) => setImmediate(r));
    expect(graph.sendText).toHaveBeenCalledTimes(2);
  });

  it('kiểm đầu vào: thiếu tên/nội dung/Page ⇒ lỗi; đã gửi thì không sửa được', async () => {
    const { svc } = setup();
    await expect(svc.create({ name: '', page_id: 'P', text: 'hi' }, 1)).rejects.toThrow(/tên/);
    await expect(svc.create({ name: 'x', page_id: 'P', text: '  ' }, 1)).rejects.toThrow(/nội dung/);
    await expect(svc.create({ name: 'x', page_id: 'ZZ', text: 'hi' }, 1)).rejects.toThrow(/Fanpage/);
    const b = await svc.create({ name: 'x', page_id: 'P', text: 'hi' }, 1);
    await svc.send(b.id, null, NOW);
    await svc.runDue(5_000, NOW);
    await expect(svc.update(b.id, { text: 'mới' })).rejects.toThrow(/không sửa/);
  });
});
