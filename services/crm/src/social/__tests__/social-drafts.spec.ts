import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SocialDraftsService } from '../social-drafts.service';

const user = { userId: 7 } as never;
const KEY = 'social/u7_1700000000000_abc123.png';
const draftRow = (over: Record<string, unknown> = {}) => ({
  id: 3, title: null, content: 'Xin chào', media: [], targets: [{ account_id: 1, caption: 'riêng', options: { first_comment: 'x' } }],
  scheduled_at: null, ui: null, post_id: null, source: 'web', created_by: 7, created_at: new Date(), updated_at: new Date(), ...over,
});

type Row = Record<string, any>;
const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);
/** So một dòng với `where` kiểu Prisma (đủ cho các truy vấn của SocialDraftsService). */
function match(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => match(row, w));
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('lt' in v) return row[k] != null && row[k] < v.lt;
      if ('in' in v) return v.in.includes(row[k]);
    }
    return same(row[k], v);
  });
}

/** Bảng nháp giả trong bộ nhớ (một dòng) — updateMany có điều kiện chạy thật để kiểm khoá giữ chỗ. */
function setup(row: Row | null = draftRow()) {
  const rows: Row[] = row ? [{ ...row }] : [];
  const apply = (r: Row, data: Row) => Object.assign(r, data, 'updated_at' in data ? {} : { updated_at: new Date(r.updated_at.getTime() + 1000) });
  const table = {
    rows,
    findMany: jest.fn(async ({ where }: Row = {}) => rows.filter((r) => match(r, where))),
    findFirst: jest.fn(async ({ where }: Row = {}) => rows.find((r) => match(r, where)) ?? null),
    findUnique: jest.fn(async ({ where }: Row) => rows.find((r) => r.id === where.id) ?? null),
    create: jest.fn(async ({ data }: Row) => ({ id: 9, ...data })),
    updateMany: jest.fn(async ({ where, data }: Row) => {
      const hit = rows.filter((r) => match(r, where));
      hit.forEach((r) => apply(r, data));
      return { count: hit.length };
    }),
    deleteMany: jest.fn(async ({ where }: Row) => {
      const n = rows.filter((r) => match(r, where)).length;
      rows.splice(0, rows.length, ...rows.filter((r) => !match(r, where)));
      return { count: n };
    }),
  };
  const prisma = {
    socialDraft: table,
    socialAccount: { findMany: jest.fn().mockImplementation(({ where }) => Promise.resolve(where.id.in.filter((i: number) => i < 100).map((id: number) => ({ id })))) },
  };
  const tx = { socialDraft: table };
  const posts = {
    // Giống create thật: chạy inTx trong "transaction" rồi trả bài.
    create: jest.fn(async (_u: unknown, _i: unknown, opts: any = {}) => {
      if (opts.inTx) await opts.inTx(tx, 55);
      return { id: 55 };
    }),
    media: { resolve: jest.fn().mockResolvedValue([{ key: KEY, type: 'image', content_type: 'image/png', size: 10 }]) },
  };
  return { svc: new SocialDraftsService(prisma as never, posts as never), prisma, posts, rows };
}

describe('bài nháp đăng đa kênh', () => {
  it('list chỉ lấy nháp chưa đăng, mới sửa trước', async () => {
    const { svc, prisma } = setup();
    await svc.list();
    expect((prisma.socialDraft.findMany.mock.calls[0] as any)[0]).toMatchObject({ orderBy: { updated_at: 'desc' } });
    expect((prisma.socialDraft.findMany.mock.calls[0] as any)[0].where.OR[0]).toEqual({ post_id: null });
  });

  it('tạo nháp trống hoàn toàn vẫn được', async () => {
    const { svc, prisma } = setup();
    await svc.create(user, {}, 'mcp:Claude');
    expect(prisma.socialDraft.create.mock.calls[0][0].data).toMatchObject({ content: '', media: [], targets: [], scheduled_at: null, source: 'mcp:Claude', created_by: 7 });
  });

  it('kiểm nhẹ: kênh không có, trùng kênh, quá dài, giờ sai ⇒ 400', async () => {
    const { svc } = setup();
    await expect(svc.create(user, { targets: [{ account_id: 999 }] })).rejects.toThrow(/#999/);
    await expect(svc.create(user, { targets: [{ account_id: 1 }, { account_id: 1 }] })).rejects.toThrow(/một lần/);
    await expect(svc.create(user, { content: 'a'.repeat(63_207) })).rejects.toThrow(BadRequestException);
    await expect(svc.create(user, { scheduled_at: 'không phải ngày' })).rejects.toThrow(/ISO/);
  });

  it('giờ hẹn trong quá khứ vẫn lưu được (chỉ kiểm khi đăng)', async () => {
    const { svc, prisma } = setup();
    await svc.create(user, { scheduled_at: '2020-01-01T00:00:00Z' });
    expect(prisma.socialDraft.create.mock.calls[0][0].data.scheduled_at).toEqual(new Date('2020-01-01T00:00:00Z'));
  });

  it('tệp: khoá mới được kiểm với thư viện, giữ tên; khoá đã có trong nháp không kiểm lại', async () => {
    const { svc, prisma, posts } = setup();
    await svc.create(user, { media: [{ key: KEY, name: 'anh.png' }] });
    expect(posts.media.resolve).toHaveBeenCalledWith(user, [KEY]);
    expect(prisma.socialDraft.create.mock.calls[0][0].data.media).toEqual([{ key: KEY, type: 'image', content_type: 'image/png', size: 10, name: 'anh.png' }]);
    const again = setup(draftRow({ media: [{ key: KEY, type: 'image', content_type: 'image/png', size: 10 }] }));
    await again.svc.update(user, 3, { media_keys: [KEY] });
    expect(again.posts.media.resolve).not.toHaveBeenCalled();
  });

  it('sửa chỉ đổi trường có gửi; nháp đã đăng ⇒ 409; không có ⇒ 404', async () => {
    const { svc, prisma } = setup();
    await svc.update(user, 3, { title: 'Tên mới' });
    expect(prisma.socialDraft.updateMany.mock.calls[0][0].data).toEqual({ post_id: null, publishing_at: null, title: 'Tên mới' });
    await expect(setup(draftRow({ post_id: 1 })).svc.update(user, 3, { content: 'x' })).rejects.toThrow(ConflictException);
    await expect(setup(null).svc.update(user, 3, {})).rejects.toThrow(NotFoundException);
  });

  it('xoá nháp đã đăng / không có ⇒ 404', async () => {
    await expect(setup(draftRow({ post_id: 55 })).svc.remove(3)).rejects.toThrow(NotFoundException);
    await expect(setup(null).svc.remove(3)).rejects.toThrow(NotFoundException);
  });

  it('đăng nháp: giữ chỗ, dựng đầu vào từ nháp, gắn post_id TRONG transaction tạo bài; updated_at không đổi', async () => {
    const v = new Date('2026-10-15T08:00:00Z');
    const { svc, posts, rows } = setup(draftRow({ updated_at: v, media: [{ key: KEY, type: 'image', content_type: 'image/png', size: 10 }], scheduled_at: new Date('2030-01-01T00:00:00Z') }));
    const post = await svc.publish(user, 3, {}, 'mcp:Claude', v);
    expect(post.id).toBe(55);
    expect(posts.create).toHaveBeenCalledWith(user, {
      content: 'Xin chào', media_keys: [KEY], targets: [{ account_id: 1, caption: 'riêng', options: { first_comment: 'x' } }], scheduled_at: '2030-01-01T00:00:00.000Z', source: 'mcp:Claude',
    }, expect.anything());
    expect(rows[0]).toMatchObject({ post_id: 55, publishing_at: null, updated_at: v });
  });

  it('expectUpdatedAt: nháp đã sửa sau khi xem trước ⇒ 409, không tạo bài', async () => {
    const { svc, posts } = setup(draftRow({ updated_at: new Date('2026-10-15T09:00:00Z') }));
    await expect(svc.publish(user, 3, {}, 'mcp', new Date('2026-10-15T08:00:00Z'))).rejects.toThrow(/đã được sửa/);
    expect(posts.create).not.toHaveBeenCalled();
  });

  it('create lỗi ⇒ nháp trả về y như cũ (kể cả updated_at) ⇒ thử lại với cùng phiên bản vẫn đăng được', async () => {
    const v = new Date('2026-10-15T08:00:00Z');
    const { svc, posts, rows } = setup(draftRow({ updated_at: v }));
    posts.create.mockRejectedValueOnce(new BadRequestException('Chọn ít nhất một kênh.'));
    await expect(svc.publish(user, 3, {}, 'mcp', v)).rejects.toThrow(/kênh/);
    expect(rows[0]).toMatchObject({ post_id: null, publishing_at: null, updated_at: v });
    await expect(svc.publish(user, 3, {}, 'mcp', v)).resolves.toMatchObject({ id: 55 });
  });

  it('ghi đè giờ hẹn khi đăng (null = đăng ngay)', async () => {
    const { svc, posts } = setup(draftRow({ scheduled_at: new Date('2030-01-01T00:00:00Z') }));
    await svc.publish(user, 3, { scheduled_at: null });
    expect((posts.create.mock.calls[0] as any)[1].scheduled_at).toBeNull();
  });

  it('đang có lượt khác giữ chỗ ⇒ lượt sau bị chặn, không tạo bài thứ hai; giữ chỗ kẹt quá 10 phút thì mở lại', async () => {
    const busy = setup(draftRow({ post_id: -1, publishing_at: new Date() }));
    await expect(busy.svc.publish(user, 3)).rejects.toThrow(NotFoundException);
    expect(busy.posts.create).not.toHaveBeenCalled();
    const stuck = setup(draftRow({ post_id: -1, publishing_at: new Date(Date.now() - 11 * 60_000) }));
    expect((await stuck.svc.list()).data).toHaveLength(1);
    await expect(stuck.svc.publish(user, 3)).resolves.toMatchObject({ id: 55 });
    expect(stuck.rows[0].post_id).toBe(55);
  });

  it('hai lượt đăng đua nhau (cùng đọc nháp) ⇒ chỉ một lượt giữ chỗ được', async () => {
    const { svc, posts, rows } = setup();
    let release!: () => void;
    posts.create.mockImplementationOnce(async (_u: unknown, _i: unknown, opts: any) => {
      await new Promise<void>((r) => (release = r));
      await opts.inTx({ socialDraft: { updateMany: async () => ({ count: 1 }) } }, 55);
      return { id: 55 };
    });
    const first = svc.publish(user, 3);
    await new Promise((r) => setImmediate(r));
    expect(rows[0].post_id).toBe(-1);
    await expect(svc.publish(user, 3)).rejects.toThrow(NotFoundException);
    release();
    await first;
    expect(posts.create).toHaveBeenCalledTimes(1);
  });

  it('sửa nội dung không kèm ui (vd trợ lý AI) ⇒ bỏ trạng thái màn soạn cũ; ui null cũng xoá; chỉ đổi tên thì giữ', async () => {
    const { svc, prisma } = setup(draftRow({ ui: { content: 'cũ' } }));
    await svc.update(user, 3, { content: 'mới' });
    expect(prisma.socialDraft.updateMany.mock.calls[0][0].data.ui).toBe(Prisma.DbNull);
    await svc.update(user, 3, { content: 'mới', ui: { content: 'mới' } });
    expect(prisma.socialDraft.updateMany.mock.calls[1][0].data.ui).toEqual({ content: 'mới' });
    await svc.update(user, 3, { ui: null });
    expect(prisma.socialDraft.updateMany.mock.calls[2][0].data.ui).toBe(Prisma.DbNull);
    await svc.update(user, 3, { title: 'Tên' });
    expect('ui' in prisma.socialDraft.updateMany.mock.calls[3][0].data).toBe(false);
  });
});

describe('đăng nháp vào hàng đợi', () => {
  it('use_queue ⇒ bỏ giờ của nháp, chuyển use_queue cho posts.create', async () => {
    const { svc, posts } = setup(draftRow({ scheduled_at: new Date('2030-01-01T00:00:00Z') }));
    await svc.publish(user, 3, { use_queue: true });
    expect(posts.create.mock.calls[0][1]).toMatchObject({ scheduled_at: null, use_queue: true });
  });
  it('không use_queue ⇒ giữ giờ của nháp như cũ', async () => {
    const { svc, posts } = setup(draftRow({ scheduled_at: new Date('2030-01-01T00:00:00Z') }));
    await svc.publish(user, 3);
    expect((posts.create.mock.calls[0][1] as any).scheduled_at).toBe('2030-01-01T00:00:00.000Z');
    expect((posts.create.mock.calls[0][1] as any).use_queue).toBeUndefined();
  });

  it('cờ "Vào hàng đợi" lưu trong nháp: bỏ giờ cụ thể; đăng thì theo cờ; ghi đè giờ lúc đăng thì thắng cờ', async () => {
    const { svc, prisma } = setup();
    await svc.create(user, { use_queue: true, scheduled_at: null });
    expect(prisma.socialDraft.create.mock.calls[0][0].data).toMatchObject({ use_queue: true, scheduled_at: null });
    await expect(svc.create(user, { use_queue: true, scheduled_at: '2030-01-01T00:00:00Z' })).rejects.toThrow(/Chỉ chọn một/);
    const d = draftRow({ use_queue: true, scheduled_at: null }) as never;
    expect(svc.toPostInput(d)).toMatchObject({ use_queue: true, scheduled_at: null });
    expect(svc.toPostInput(d, { scheduled_at: '2030-01-01T00:00:00.000Z' })).toMatchObject({ use_queue: undefined, scheduled_at: '2030-01-01T00:00:00.000Z' });
    // Đặt giờ cụ thể khi sửa ⇒ bỏ cờ hàng đợi
    await svc.update(user, 3, { scheduled_at: '2030-01-01T00:00:00Z' });
    expect((prisma.socialDraft.updateMany.mock.calls.at(-1) as any)[0].data).toMatchObject({ use_queue: false });
  });
});
