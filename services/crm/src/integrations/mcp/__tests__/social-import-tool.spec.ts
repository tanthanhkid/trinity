import { ConflictException } from '@nestjs/common';
import { SocialImportService } from '../../../social/social-import.service';
import { actionToolByName } from '../actions/action-registry';
import { ActionUserError } from '../actions/action-types';
import { loadMcpSdk } from '../mcp-sdk';
import { MCP_TOOLS } from '../mcp-tools.registry';

const user = { userId: 1, email: 'a@x.vn', isAdmin: true, grants: {} } as never;
const tool = actionToolByName('import_social_posts')!;
const vnDay = (n: number, hhmm = '09:00') => `${new Date(Date.now() + n * 86_400_000 + 7 * 3_600_000).toISOString().slice(0, 10)}T${hhmm}`;

function setup(over: { accounts?: unknown[] } = {}) {
  const accounts = over.accounts ?? [{ id: 1, network: 'facebook', name: 'Fanpage', status: 'active' }, { id: 2, network: 'youtube', name: 'Kênh YT', status: 'active' }];
  const prisma = { socialAccount: { findMany: jest.fn(async () => accounts) }, socialMediaAsset: { findMany: jest.fn(async () => []) } };
  const posts = {
    validate: jest.fn(async (_u: unknown, i: any) => ({ scheduledAt: i.scheduled_at ? new Date(i.scheduled_at) : null })),
    create: jest.fn(async (..._a: any[]) => ({ id: 55 })),
  };
  const drafts = { check: jest.fn(async () => undefined), create: jest.fn(async (..._a: any[]) => ({ id: 9 })) };
  // Khung trống ổn định giữa lúc xem trước và lúc chạy (khung nằm trong mã kế hoạch).
  const base = Date.now();
  const queue = { nextFree: jest.fn(async (c: number) => Array.from({ length: c }, (_, i) => new Date(base + (5 + i) * 86_400_000))) };
  const importer = new SocialImportService(prisma as never, posts as never, drafts as never, queue as never);
  const deps = { social: { importer, posts, drafts, queue }, orgFeatures: { isEnabled: jest.fn(async () => true) } } as any;
  return { deps, posts, drafts, ctx: { deps, user } as never };
}

describe('import_social_posts', () => {
  it('là tool ghi (crm.write) trong danh sách MCP, mô tả nói rõ drafts không đăng và schedule cần confirmed_by_user', () => {
    const t = MCP_TOOLS.find((x) => x.name === 'import_social_posts')!;
    expect(t.scope).toBe('crm.write');
    expect(t.description).toMatch(/drafts/);
    expect(t.description).toMatch(/confirmed_by_user/);
  });

  it('drafts: ghi thẳng không cần xác nhận, nguồn mcp, không đụng posts.create', async () => {
    const { ctx, drafts, posts } = setup();
    const p = await tool.prepare({ mode: 'drafts', rows: [{ content: 'Nháp 1' }, { content: 'Nháp 2', account_ids: [1], use_queue: true }] }, ctx);
    expect(p.summary).toMatch(/2 bài nháp/);
    const r = await tool.execute(p.params, ctx, 1);
    expect(r).toMatchObject({ mode: 'drafts', created_count: 2, skipped: [] });
    expect(drafts.create).toHaveBeenCalledTimes(2);
    expect(drafts.create.mock.calls[0][2]).toBe('mcp');
    expect(posts.create).not.toHaveBeenCalled();
  });

  it('schedule không có confirmed_by_user ⇒ chỉ trả bản xem trước từng dòng (kênh, giờ, lỗi), chưa tạo gì', async () => {
    const { ctx, posts, drafts } = setup();
    const rows = [{ content: 'A', account_ids: [1], scheduled_at: vnDay(2) }, { content: 'B', account_ids: [2], use_queue: true }, { content: 'C', account_ids: [1] }];
    const err: Error = await tool.prepare({ mode: 'schedule', rows }, ctx).then(() => new Error('không ném'), (e) => e);
    expect(err).toBeInstanceOf(ActionUserError);
    expect(err.message).toMatch(/Chưa đăng gì/);
    expect(err.message).toMatch(/Dòng 1: Fanpage/);
    expect(err.message).toMatch(/Dòng 2: Kênh YT — hàng đợi/);
    expect(err.message).toMatch(/Dòng 3:.*LỖI:.*Cần giờ đăng hoặc 'hàng đợi'/);
    expect(posts.create).not.toHaveBeenCalled();
    expect(drafts.create).not.toHaveBeenCalled();
  });

  it('schedule có xác nhận ⇒ tạo dòng hợp lệ, báo dòng lỗi ở skipped; params chỉ có dòng chuẩn hoá + băm', async () => {
    const { ctx, posts } = setup();
    const rows = [{ content: 'A', account_ids: [1], scheduled_at: vnDay(2) }, { content: 'B', account_ids: [2], use_queue: true }, { content: 'C', account_ids: [1] }];
    const p = await tool.prepare({ mode: 'schedule', rows, confirmed_by_user: 'ok tạo đi' }, ctx);
    expect(p.params).toMatchObject({ mode: 'schedule', plan_hash: expect.stringMatching(/^[0-9a-f]{64}$/), rows: expect.any(Array) });
    expect(p.summary).toMatch(/2 bài hẹn giờ từ 3 dòng/);
    const r = await tool.execute(p.params, ctx, 1);
    expect(r.created_count).toBe(2);
    expect(r.skipped).toEqual([{ row: 3, errors: ["Cần giờ đăng hoặc 'hàng đợi'."] }]);
    expect(posts.create).toHaveBeenCalledTimes(2);
    expect(posts.create.mock.calls[0][1].source).toBe('mcp');
  });

  it('tạo lại bài bằng đề xuất cũ khi dữ liệu đã đổi (kênh bị gỡ) ⇒ từ chối, không tạo gì', async () => {
    const { ctx, deps, posts } = setup();
    const p = await tool.prepare({ mode: 'schedule', rows: [{ content: 'A', account_ids: [1], scheduled_at: vnDay(2) }], confirmed_by_user: 'ok tạo đi' }, ctx);
    deps.social.importer.prisma.socialAccount.findMany.mockResolvedValue([{ id: 2, network: 'youtube', name: 'Kênh YT', status: 'active' }]);
    await expect(tool.execute(p.params, ctx, 1)).rejects.toThrow(ActionUserError);
    await expect(tool.execute({ ...p.params, plan_hash: 'a'.repeat(64) }, ctx, 1)).rejects.toThrow(/preview/);
    expect(posts.create).not.toHaveBeenCalled();
  });

  it('băm khác ở service ⇒ ConflictException; không dòng nào hợp lệ ⇒ lỗi, chưa tạo gì; quá 50 dòng bị schema chặn', async () => {
    const { ctx, deps } = setup();
    await expect(deps.social.importer.importRows(user, [{ row: 1, content: 'A', channels: ['1'], scheduled_at: vnDay(2), media: [] }], 'schedule', 'b'.repeat(64), 'mcp')).rejects.toBeInstanceOf(ConflictException);
    await expect(tool.prepare({ mode: 'schedule', rows: [{ content: 'A' }], confirmed_by_user: 'ok tạo đi' }, ctx)).rejects.toThrow(/Không dòng nào hợp lệ/);
    const { z } = loadMcpSdk();
    const shape = z.object(tool.input(z));
    expect(shape.safeParse({ mode: 'drafts', rows: Array.from({ length: 51 }, () => ({ content: 'x' })) }).success).toBe(false);
    expect(shape.safeParse({ mode: 'drafts', rows: [{ content: 'x' }] }).success).toBe(true);
    expect(shape.safeParse({ mode: 'now', rows: [{ content: 'x' }] }).success).toBe(false);
  });

  it('tính năng đăng đa kênh tắt ⇒ báo lỗi', async () => {
    const { ctx, deps } = setup();
    deps.orgFeatures.isEnabled.mockResolvedValue(false);
    await expect(tool.prepare({ mode: 'drafts', rows: [{ content: 'x' }] }, ctx)).rejects.toThrow(/đang tắt/);
  });
});
