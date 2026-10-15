import { BadRequestException, ConflictException } from '@nestjs/common';
import { SocialImportService } from '../social-import.service';
import { NO_QUEUE_SLOTS } from '../social-queue.service';

const user = { userId: 1 } as never;
const ACCOUNTS = [
  { id: 1, network: 'facebook', name: 'Fanpage', status: 'active' },
  { id: 2, network: 'youtube', name: 'Kênh YT', status: 'active' },
  { id: 3, network: 'facebook', name: 'Trùng', status: 'active' },
  { id: 4, network: 'instagram', name: 'Trùng', status: 'active' },
];
const ASSETS = [
  { key: 'social/u1_2_b.png', name: 'logo.png' },
  { key: 'social/u1_1_a.png', name: 'logo.png' },
  { key: 'social/u1_3_c.mp4', name: 'clip.mp4' },
];
const FUTURE = '2099-01-01 09:00'; // quá 90 ngày
const day = (n: number) => new Date(Date.now() + n * 86_400_000);
/** Giờ VN dạng "YYYY-MM-DD HH:mm" của n ngày tới, 09:00 giờ VN. */
const vn = (n: number) => `${new Date(day(n).getTime() + 7 * 3_600_000).toISOString().slice(0, 10)} 09:00`;
const BASE = Date.now();
const slot = (i: number) => new Date(BASE + (3 + i) * 86_400_000);

function setup(opts: { slots?: Date[]; validate?: (input: any) => unknown } = {}) {
  const prisma = {
    socialAccount: { findMany: jest.fn(async () => ACCOUNTS) },
    socialMediaAsset: { findMany: jest.fn(async () => ASSETS) },
  };
  const posts = {
    validate: jest.fn(async (_u: unknown, input: any) => {
      if (opts.validate) opts.validate(input);
      return { scheduledAt: input.scheduled_at ? new Date(input.scheduled_at) : null };
    }),
    create: jest.fn(async (_u: unknown, input: any) => ({ id: 100 + input.targets[0].account_id })),
  };
  const drafts = { check: jest.fn(async () => undefined), create: jest.fn(async () => ({ id: 7 })) };
  const queue = { nextFree: jest.fn(async (n: number) => (opts.slots ?? [slot(0), slot(1), slot(2), slot(3)]).slice(0, n)) };
  const svc = new SocialImportService(prisma as never, posts as never, drafts as never, queue as never);
  return { svc, prisma, posts, drafts, queue };
}
const csv = (...lines: string[]) => ['noi_dung,kenh,gio_dang,tep,binh_luan_dau,tieu_de_youtube,utm', ...lines].join('\n');

describe('SocialImportService.plan — kênh, tệp, giờ', () => {
  it('tên kênh → id (đúng tên, không phân biệt hoa thường), id số, tên trùng ⇒ lỗi, tên lạ ⇒ lỗi', async () => {
    const { svc } = setup();
    const p = await svc.plan(user, csv(`a,Fanpage,${vn(2)},,,,`, `b,"kênh yt; 1",${vn(2)},,,,`, `c,Trùng,${vn(2)},,,,`, `d,Không có,${vn(2)},,,,`, `e,2,${vn(2)},,,,`), 'schedule');
    expect(p.rows[0].preview.channels).toEqual([{ account_id: 1, name: 'Fanpage', network: 'facebook' }]);
    expect(p.rows[1].preview.channels.map((c) => c.account_id)).toEqual([2, 1]);
    expect(p.rows[2].errors.join()).toMatch(/trùng nhiều kênh/);
    expect(p.rows[3].errors.join()).toMatch(/Không tìm thấy kênh "Không có"/);
    expect(p.rows[4].preview.channels[0].account_id).toBe(2);
    expect(p.rows.map((r) => r.row)).toEqual([2, 3, 4, 5, 6]);
    expect(p.ok_count).toBe(3);
    expect(p.error_count).toBe(2);
  });

  it('tệp: khoá trước, rồi tên gốc (trùng tên lấy tệp mới nhất + cảnh báo), tên lạ ⇒ lỗi', async () => {
    const { svc, posts } = setup();
    const p = await svc.plan(user, csv(`a,Fanpage,${vn(2)},"logo.png;social/u1_3_c.mp4",,,`, `b,Fanpage,${vn(2)},nope.png,,,`), 'schedule');
    expect(p.rows[0].ok).toBe(true);
    expect(p.rows[0].warnings.join()).toMatch(/2 tệp tên "logo.png"/);
    expect(posts.validate.mock.calls[0][1].media_keys).toEqual(['social/u1_2_b.png', 'social/u1_3_c.mp4']);
    expect(p.rows[1].errors.join()).toMatch(/Không thấy tệp "nope.png"/);
  });

  it('giờ Việt Nam: hai dạng ngày ra cùng thời điểm UTC; sai dạng / đã qua / quá 90 ngày ⇒ lỗi', async () => {
    const { svc } = setup();
    const d = vn(3); // YYYY-MM-DD HH:mm
    const [y, m, dd] = d.slice(0, 10).split('-');
    const p = await svc.plan(user, csv(`a,Fanpage,${d},,,,`, `b,Fanpage,${dd}/${m}/${y} 09:00,,,,`, 'c,Fanpage,mai 9h,,,,', 'd,Fanpage,2020-01-01 09:00,,,,', `e,Fanpage,${FUTURE},,,,`), 'schedule');
    expect(p.rows[0].preview.scheduled_at).toBe(p.rows[1].preview.scheduled_at);
    expect(p.rows[0].preview.scheduled_at).toMatch(/T02:00:00\.000Z$/);
    expect(p.rows[2].errors.join()).toMatch(/không đúng dạng/);
    expect(p.rows[3].errors.join()).toMatch(/ít nhất 1 phút/);
    expect(p.rows[4].errors.join()).toMatch(/90 ngày/);
  });

  it('first_comment chỉ áp cho Facebook, youtube_title chỉ cho YouTube, utm_campaign → utm; thiếu kênh phù hợp ⇒ cảnh báo', async () => {
    const { svc, posts } = setup();
    const p = await svc.plan(user, csv(`a,"Fanpage;Kênh YT",${vn(2)},social/u1_3_c.mp4,"bình luận","Tiêu đề",thu 10`, `b,Kênh YT,${vn(2)},,"x",,`), 'schedule');
    const input = posts.validate.mock.calls[0][1];
    expect(input.targets).toEqual([{ account_id: 1, options: { first_comment: 'bình luận' } }, { account_id: 2, options: { title: 'Tiêu đề' } }]);
    expect(input.utm).toEqual({ campaign: 'thu-10' });
    expect(p.rows[1].warnings.join()).toMatch(/Không có kênh Facebook/);
  });
});

describe('chế độ schedule', () => {
  it('dòng không có giờ bị từ chối, không bao giờ thành đăng ngay', async () => {
    const { svc, posts } = setup();
    const p = await svc.plan(user, csv('a,Fanpage,,,,,'), 'schedule');
    expect(p.rows[0].ok).toBe(false);
    expect(p.rows[0].errors).toContain("Cần giờ đăng hoặc 'hàng đợi'.");
    expect(posts.validate).not.toHaveBeenCalled();
    // nhập thật thì dòng đó nằm ở skipped, không tạo bài
    const r = await svc.importCsv(user, csv('a,Fanpage,,,,,'), 'schedule', p.plan_hash);
    expect(r.created).toEqual([]);
    expect(r.skipped[0].errors).toContain("Cần giờ đăng hoặc 'hàng đợi'.");
    expect(posts.create).not.toHaveBeenCalled();
  });

  it('thiếu kênh ⇒ lỗi; thiếu cả chữ và tệp ⇒ lỗi', async () => {
    const { svc } = setup();
    const p = await svc.plan(user, csv(`a,,${vn(2)},,,,`, `,Fanpage,${vn(2)},,,,`), 'schedule');
    expect(p.rows[0].errors).toContain('Cần ít nhất một kênh.');
    expect(p.rows[1].errors).toContain('Cần nội dung hoặc ảnh/video.');
  });

  it('hàng đợi: xin khung MỘT lần cho mọi dòng hợp lệ, gán theo thứ tự dòng, mỗi dòng một khung', async () => {
    const { svc, queue, posts } = setup();
    const text = csv('a,Fanpage,queue,,,,', 'b,Fanpage,hàng đợi,,,,', 'c,Không có,queue,,,,', `d,Fanpage,${vn(2)},,,,`, 'e,Fanpage,queue,,,,');
    const p = await svc.plan(user, text, 'schedule');
    expect(queue.nextFree).toHaveBeenCalledTimes(1);
    expect(queue.nextFree).toHaveBeenCalledWith(3); // dòng c lỗi kênh ⇒ không chiếm khung
    const times = [p.rows[0], p.rows[1], p.rows[4]].map((r) => r.preview.scheduled_at);
    expect(times).toEqual([slot(0), slot(1), slot(2)].map((d) => d.toISOString()));
    expect(new Set(times).size).toBe(3);
    expect(p.rows[0].preview.use_queue).toBe(true);
    // nhập thật: các bài tạo với giờ riêng, theo thứ tự
    const r = await svc.importCsv(user, text, 'schedule', p.plan_hash);
    expect(r.created.map((c) => c.row)).toEqual([2, 3, 5, 6]);
    expect(posts.create.mock.calls.map((c) => c[1].scheduled_at).filter((t) => times.includes(t))).toEqual(times);
    expect(posts.create.mock.calls.every((c) => c[1].use_queue === undefined && c[1].scheduled_at)).toBe(true);
  });

  it('hết khung: dòng dư báo lỗi; chưa đặt khung nào ⇒ báo NO_QUEUE_SLOTS', async () => {
    const a = setup({ slots: [slot(0)] });
    const p = await a.svc.plan(user, csv('a,Fanpage,queue,,,,', 'b,Fanpage,queue,,,,'), 'schedule');
    expect(p.rows[0].ok).toBe(true);
    expect(p.rows[1].errors.join()).toMatch(/Không đủ khung trống/);
    const b = setup({ slots: [] });
    expect((await b.svc.plan(user, csv('a,Fanpage,queue,,,,'), 'schedule')).rows[0].errors).toContain(NO_QUEUE_SLOTS);
  });

  it('lỗi validate của một dòng (kênh cần liên kết lại, vượt giới hạn…) nằm ở dòng đó', async () => {
    const { svc } = setup({
      validate: (i) => {
        if (i.content === 'dai') throw new BadRequestException('Fanpage: nội dung quá dài.');
      },
    });
    const p = await svc.plan(user, csv(`dai,Fanpage,${vn(2)},,,,`, `ngan,Fanpage,${vn(2)},,,,`), 'schedule');
    expect(p.rows.map((r) => r.ok)).toEqual([false, true]);
    expect(p.rows[0].errors).toEqual(['Fanpage: nội dung quá dài.']);
  });
});

describe('chế độ drafts', () => {
  it('không cần giờ, không cần kênh; hàng đợi chỉ đánh dấu use_queue, không xin khung', async () => {
    const { svc, queue, drafts, posts } = setup();
    const text = csv('chỉ có chữ,,,,,,', 'b,Fanpage,queue,,,,', `c,Fanpage,${vn(2)},,,,`);
    const p = await svc.plan(user, text, 'drafts');
    expect(p.ok_count).toBe(3);
    expect(queue.nextFree).not.toHaveBeenCalled();
    expect(drafts.check.mock.calls.map((c: any) => [c[1].use_queue, c[1].scheduled_at ? 'time' : null])).toEqual([[undefined, null], [true, null], [undefined, 'time']]);
    const r = await svc.importCsv(user, text, 'drafts', p.plan_hash);
    expect(r.created).toHaveLength(3);
    expect(drafts.create).toHaveBeenCalledTimes(3);
    expect(drafts.create.mock.calls[0]).toEqual([user, expect.any(Object), 'csv', expect.stringMatching(/^csv-import:[0-9a-f]{16}:2$/)]);
    expect(posts.create).not.toHaveBeenCalled();
  });

  it('giờ đã qua chỉ là cảnh báo ở chế độ nháp', async () => {
    const { svc } = setup();
    const p = await svc.plan(user, csv('a,Fanpage,2020-01-01 09:00,,,,'), 'drafts');
    expect(p.rows[0].ok).toBe(true);
    expect(p.rows[0].warnings.join()).toMatch(/đã qua/);
  });
});

describe('nhập thật', () => {
  const text = csv(`a,Fanpage,${vn(2)},,,,`, `b,Kênh YT,${vn(3)},,,,`, `c,Fanpage,${vn(4)},,,,`, 'x,Fanpage,,,,,');

  it('plan_hash khác ⇒ 409, không tạo gì', async () => {
    const { svc, posts } = setup();
    const p = await svc.plan(user, text, 'schedule');
    await expect(svc.importCsv(user, text, 'schedule', 'f'.repeat(64))).rejects.toBeInstanceOf(ConflictException);
    // sửa một dòng sau khi xem ⇒ băm đổi ⇒ 409
    await expect(svc.importCsv(user, text.replace('a,Fanpage', 'a2,Fanpage'), 'schedule', p.plan_hash)).rejects.toBeInstanceOf(ConflictException);
    // đổi chế độ ⇒ 409
    await expect(svc.importCsv(user, text, 'drafts', p.plan_hash)).rejects.toBeInstanceOf(ConflictException);
    expect(posts.create).not.toHaveBeenCalled();
  });

  it('chỉ tạo dòng hợp lệ; một dòng tạo lỗi không kéo theo dòng khác', async () => {
    const { svc, posts } = setup();
    const p = await svc.plan(user, text, 'schedule');
    expect(p.plan_hash).toMatch(/^[0-9a-f]{64}$/);
    posts.create.mockImplementationOnce(async () => ({ id: 101 })).mockImplementationOnce(async () => {
      throw new Error('boom nội bộ');
    });
    const r = await svc.importCsv(user, text, 'schedule', p.plan_hash);
    expect(r.created).toEqual([{ row: 2, id: 101 }, { row: 4, id: 101 }]);
    expect(r.skipped.map((s) => s.row)).toEqual([3, 5]);
    expect(r.skipped[0].errors).toEqual(['Không kiểm tra được dòng này lúc này — thử lại sau.']); // không lộ chi tiết nội bộ
    expect(r.skipped[1].errors).toContain("Cần giờ đăng hoặc 'hàng đợi'.");
  });

  it('cùng dữ liệu ⇒ cùng băm; khung hàng đợi đổi ⇒ băm đổi', async () => {
    const q = csv('a,Fanpage,queue,,,,');
    const a = await setup({ slots: [slot(0)] }).svc.plan(user, q, 'schedule');
    const a2 = await setup({ slots: [slot(0)] }).svc.plan(user, q, 'schedule');
    const b = await setup({ slots: [slot(5)] }).svc.plan(user, q, 'schedule');
    expect(a.plan_hash).toBe(a2.plan_hash);
    // Khung hàng đợi đổi ⇒ mã khác ⇒ nhập bị từ chối, người dùng kiểm lại thấy giờ mới.
    expect(a.plan_hash).not.toBe(b.plan_hash);
  });

  it('giới hạn 200 dòng ở cả plan và import', async () => {
    const { svc } = setup();
    const big = ['content', ...Array.from({ length: 201 }, (_, i) => `b${i}`)].join('\n');
    await expect(svc.plan(user, big, 'drafts')).rejects.toThrow(/Tối đa 200 dòng/);
    await expect(svc.importCsv(user, big, 'drafts', 'x'.repeat(64))).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.planRows(user, Array.from({ length: 201 }, (_, i) => ({ row: i + 1, channels: [], media: [] })), 'drafts')).rejects.toThrow(/Tối đa 200/);
  });

  it('mode sai ⇒ 400', async () => {
    await expect(setup().svc.plan(user, csv('a,Fanpage,queue,,,,'), 'now' as never)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('chống tạo lặp và tên kênh mơ hồ', () => {
  it('mỗi dòng mang khoá chống lặp riêng; gửi lại cùng lượt ⇒ dòng đã tạo báo "đã tạo", không tạo lần hai', async () => {
    const { svc, posts } = setup();
    const text = csv(`A,Fanpage,${vn(2)},,,,`, `B,Fanpage,${vn(3)},,,,`);
    const p = await svc.plan(user, text, 'schedule');
    await svc.importCsv(user, text, 'schedule', p.plan_hash);
    const keys = posts.create.mock.calls.map((c) => (c as unknown as [unknown, unknown, { dedupeSource?: string }])[2]?.dedupeSource);
    expect(keys).toEqual([expect.stringMatching(/^csv-import:[0-9a-f]{16}:2$/), expect.stringMatching(/^csv-import:[0-9a-f]{16}:3$/)]);
    // Lần gửi lại: service tạo bài thấy khoá đã có ⇒ 409
    posts.create.mockRejectedValue(Object.assign(new Error('Dòng này đã được tạo ở lần nhập trước — không tạo lại.'), { status: 409 }));
    const again = await svc.importCsv(user, text, 'schedule', p.plan_hash);
    expect(again.created).toEqual([]);
    expect(again.skipped.map((s) => s.errors[0])).toEqual(expect.arrayContaining([expect.stringMatching(/đã được tạo/)]));
  });

  it('số vừa là id kênh vừa là tên kênh khác ⇒ lỗi, không đoán', async () => {
    ACCOUNTS.push({ id: 5, network: 'youtube', name: '1', status: 'active' });
    try {
      const { svc } = setup();
      const p = await svc.plan(user, csv(`A,1,${vn(2)},,,,`), 'schedule');
      expect(p.rows[0].ok).toBe(false);
      expect(p.rows[0].errors.join(' ')).toMatch(/vừa là id kênh vừa là tên/);
    } finally {
      ACCOUNTS.pop();
    }
  });
});
