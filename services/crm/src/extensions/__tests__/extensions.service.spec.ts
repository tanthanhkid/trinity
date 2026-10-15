/**
 * Luồng NHÁP → DUYỆT → deploy → quay lui của kho chương trình con. Mặc định chạy trên Prisma giả trong bộ nhớ;
 * có TEST_DATABASE_URL (DB đã migrate) thì chạy lại CÙNG kịch bản trên Postgres thật:
 *   TEST_DATABASE_URL=postgresql://localhost:5432/trinity_ext_scratch pnpm --filter @trinity/crm test extensions.service
 */
import { NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ExtensionInputError } from '../extension-errors';
import { ExtensionsService, MAX_OPEN_DRAFTS } from '../extensions.service';
import { fakePrisma } from './fake-prisma';

const MANIFEST = { net: ['api.example.com'], tables: { read: ['khach_hang'], write: ['khach_hang'] }, schedule: '0 8 * * *' };
const CODE = 'export default async function (ctx) { ctx.log("hi"); return 1 }';
const dbUrl = process.env.TEST_DATABASE_URL;

function build(prisma: unknown) {
  const runtime = { activate: jest.fn().mockResolvedValue(undefined), deactivate: jest.fn().mockResolvedValue(undefined), dryRun: jest.fn().mockResolvedValue({ outcome: 'ok' }) };
  const notifications = { findUserIdsWithPermission: jest.fn().mockResolvedValue([9]), createPendingLogs: jest.fn().mockResolvedValue({ created: 1 }) };
  return { svc: new ExtensionsService(prisma as never, runtime as never, notifications as never), runtime, notifications };
}

describe.each([['Prisma giả', () => fakePrisma() as unknown], ...(dbUrl ? [['Postgres thật', () => new PrismaClient({ datasources: { db: { url: dbUrl } } }) as unknown]] : [])] as [string, () => unknown][])(
  'ExtensionsService — %s',
  (_name, mk) => {
    const prisma = mk();
    const { svc, runtime, notifications } = build(prisma);
    const key = () => `ext-${Math.random().toString(36).slice(2, 10)}`;
    const make = async (k = key()) => (await svc.create(1, { key: k, kind: 'job', name: 'Đồng bộ Sheet', code: CODE, manifest: MANIFEST })).extension;

    beforeAll(() => {
      process.env.EXTENSIONS_ENABLED = 'true';
    });
    afterAll(async () => {
      delete process.env.EXTENSIONS_ENABLED;
      await (prisma as { $disconnect?: () => Promise<void> }).$disconnect?.();
    });

    it('create: nháp v1, chưa chạy, báo người duyệt; key trùng bị từ chối', async () => {
      const k = key();
      const r = await svc.create(1, { key: k, kind: 'job', name: 'X', code: CODE, manifest: MANIFEST });
      expect(r.extension).toMatchObject({ key: k, status: 'draft', active_version: null, latest_version: 1 });
      expect(r.version).toMatchObject({ version: 1, review_status: 'draft' });
      expect(notifications.createPendingLogs).toHaveBeenCalledWith([9], 'extension.pending', expect.objectContaining({ action_url: expect.stringContaining('/extensions?id=') }));
      await expect(svc.create(1, { key: k, kind: 'job', code: CODE, manifest: MANIFEST })).rejects.toThrow(/đã có chương trình con khác/);
    });

    it('deploy bản CHƯA duyệt ⇒ từ chối, không kích hoạt runtime', async () => {
      const e = await make();
      runtime.activate.mockClear();
      await expect(svc.deploy(e.key)).rejects.toThrow(/Chưa có phiên bản nào được NGƯỜI duyệt/);
      await expect(svc.deploy(e.key, 1)).rejects.toThrow(/chưa được NGƯỜI duyệt/);
      expect(runtime.activate).not.toHaveBeenCalled();
    });

    it('chạy thử bản CHƯA duyệt vừa có net vừa có tables ⇒ từ chối (chống rò dữ liệu); duyệt rồi thì được', async () => {
      const e = await make();
      runtime.dryRun.mockClear();
      await expect(svc.dryRun(1, e.key, 1, {})).rejects.toThrow(/chống rò dữ liệu/);
      expect(runtime.dryRun).not.toHaveBeenCalled();
      const only = (await svc.create(1, { key: key(), kind: 'job', code: CODE, manifest: { net: [], tables: { read: ['khach_hang'], write: [] }, schedule: '0 8 * * *' } })).extension;
      await expect(svc.dryRun(1, only.key, 1, {})).resolves.toBeDefined();
      await svc.approve(7, e.id, 1);
      await expect(svc.dryRun(1, e.key, 1, {})).resolves.toBeDefined();
    });

    it('nháp → duyệt → deploy → active; deploy chạy đúng phiên bản đã duyệt', async () => {
      const e = await make();
      expect((await svc.approve(7, e.id, 1)).status).toBe('approved');
      const d = await svc.deploy(e.key);
      expect(d).toMatchObject({ status: 'active', active_version: 1, consecutive_failures: 0 });
      expect(runtime.activate).toHaveBeenCalledWith(expect.objectContaining({ id: e.id }), expect.objectContaining({ version: 1, review_status: 'approved', reviewed_by: 7 }));
    });

    it('sửa = phiên bản MỚI; bản đang chạy giữ nguyên, bản mới phải được duyệt lại', async () => {
      const e = await make();
      await svc.approve(7, e.id, 1);
      await svc.deploy(e.key);
      const u = await svc.update(1, e.key, { code: `${CODE}\n// v2`, note: 'đổi' });
      expect(u.version).toMatchObject({ version: 2, review_status: 'draft', note: 'đổi' });
      expect(u.extension).toMatchObject({ status: 'active', active_version: 1, latest_version: 2 });
      await expect(svc.deploy(e.key, 2)).rejects.toThrow(/chưa được NGƯỜI duyệt/);
      expect((await svc.getVersion(e.key, 1)).version.code).toBe(CODE); // bản cũ bất biến
      expect((await svc.getVersion(e.key, 2)).version.code).toContain('// v2');
    });

    it('chưa chạy mà có nháp mới ⇒ về draft', async () => {
      const e = await make();
      await svc.approve(7, e.id, 1);
      expect((await svc.update(1, e.key, { description: 'mới' })).extension.status).toBe('draft');
    });

    it('từ chối kèm lý do; bản đã xử lý không duyệt lại được', async () => {
      const e = await make();
      const r = await svc.reject(7, e.id, 1, 'xin host lạ');
      expect(r.status).toBe('draft');
      expect((await svc.getVersion(e.id, 1)).version).toMatchObject({ review_status: 'rejected', review_note: 'xin host lạ', reviewed_by: 7 });
      await expect(svc.approve(7, e.id, 1)).rejects.toThrow(/đã được xử lý/);
      await expect(svc.deploy(e.key, 1)).rejects.toThrow(/bị từ chối/);
    });

    it('quay lui: chỉ về bản ĐÃ DUYỆT; chưa deploy lần nào thì không quay lui được', async () => {
      const e = await make();
      await expect(svc.rollback(e.key, 1)).rejects.toThrow(/chưa từng được deploy/);
      await svc.approve(7, e.id, 1);
      await svc.deploy(e.key);
      await svc.update(1, e.key, { code: `${CODE}\n// v2` });
      await svc.update(1, e.key, { code: `${CODE}\n// v3` });
      await svc.approve(7, e.id, 2);
      await svc.deploy(e.key, 2);
      await expect(svc.rollback(e.key, 3)).rejects.toThrow(/chưa duyệt/);
      await expect(svc.rollback(e.key, 2)).rejects.toThrow(/đang chạy rồi/);
      expect(await svc.rollback(e.key, 1)).toMatchObject({ status: 'active', active_version: 1 });
    });

    it('tắt rồi deploy/quay lui của agent KHÔNG bật lại ngầm; chỉ enable (người) mới bật', async () => {
      const e = await make();
      await svc.approve(7, e.id, 1);
      await svc.deploy(e.key);
      await svc.update(1, e.key, { code: `${CODE}\n// v2` });
      await svc.approve(7, e.id, 2);
      expect(await svc.disable(e.key, 'lỗi')).toMatchObject({ status: 'disabled', disabled_reason: 'lỗi' });
      expect(runtime.deactivate).toHaveBeenCalledWith(e.id);
      runtime.activate.mockClear();
      expect(await svc.deploy(e.key, 2)).toMatchObject({ status: 'disabled', active_version: 2 });
      expect(await svc.rollback(e.key, 1)).toMatchObject({ status: 'disabled', active_version: 1 });
      expect(runtime.activate).not.toHaveBeenCalled();
      expect(await svc.enable(e.key)).toMatchObject({ status: 'active', active_version: 1, disabled_reason: null });
      expect(runtime.activate).toHaveBeenCalledTimes(1);
    });

    it('chặn spam: tối đa số bản nháp chưa duyệt', async () => {
      const e = await make();
      for (let i = 0; i < MAX_OPEN_DRAFTS - 1; i++) await svc.update(1, e.key, { note: `n${i}` });
      await expect(svc.update(1, e.key, { note: 'thừa' })).rejects.toThrow(/bản nháp chưa được duyệt/);
    });

    it('đầu vào sai: key, loại, manifest, mã', async () => {
      const bad = (o: object) => svc.create(1, { key: key(), kind: 'job', code: CODE, manifest: MANIFEST, ...o });
      await expect(bad({ key: 'Có Dấu' })).rejects.toBeInstanceOf(ExtensionInputError);
      await expect(bad({ kind: 'cron' })).rejects.toThrow(/kind phải là/);
      await expect(bad({ code: '   ' })).rejects.toThrow(/không được rỗng/);
      await expect(bad({ manifest: { ...MANIFEST, schedule: undefined } })).rejects.toThrow(/cần "schedule"/);
      await expect(bad({ manifest: { ...MANIFEST, net: ['127.0.0.1:5432'] } })).rejects.toThrow(/địa chỉ nội bộ/);
    });

    it('không thấy / logs / list', async () => {
      await expect(svc.get('khong-co-nay')).rejects.toBeInstanceOf(NotFoundException);
      const e = await make();
      expect((await svc.list({ status: 'draft' })).some((x) => x.id === e.id)).toBe(true);
      expect((await svc.logs(e.id)).runs).toEqual([]);
    });
  },
);
