/**
 * MCP + mã chung — DB THẬT: import_records nhiều bảng ghép liên kết bằng khoá nghiệp vụ trong CÙNG một lần duyệt, find_by_code,
 * get_record theo mã, link_records. Chỉ chạy khi có TEST_DATABASE_URL (DB đã migrate), vd:
 *   TEST_DATABASE_URL=postgresql://localhost:5432/trinity_ma_chung pnpm --filter @trinity/crm test codes-links.db
 */
import { PrismaClient } from '@prisma/client';
import type { Grants } from '@trinity/rbac';
import { ScopeService, type AuthUser } from '@trinity/rbac-nest';
import { CustomRecordsListService } from '../../../custom-objects/custom-records-list.service';
import { CustomRecordsService } from '../../../custom-objects/custom-records.service';
import { RecordPresenter } from '../../../custom-objects/record-presenter.service';
import { RecordValidator } from '../../../custom-objects/record-validator.service';
import { RecordLinksService } from '../../../custom-objects/refs/record-links.service';
import { RecordRefsService } from '../../../custom-objects/refs/record-refs.service';
import { actionToolByName } from '../actions/action-registry';
import type { ActionDeps } from '../actions/action-types';
import { writeTables } from '../actions/import-custom';
import { MCP_TOOLS } from '../mcp-tools.registry';
import { useDbSpecLock } from '../../../test-utils/db-spec-lock';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const GRANTS = { 'custom_records.view': 'all', 'custom_records.manage': 'all', 'custom_objects.manage': true, 'contacts.view': 'all' } as unknown as Grants;

d('MCP mã chung + liên kết — DB thật', () => {
  useDbSpecLock(url as string);
  let prisma: PrismaClient;
  let deps: ActionDeps;
  let user: AuthUser;
  const act = (n: string) => actionToolByName(n)!;
  const tool = (n: string) => MCP_TOOLS.find((t) => t.name === n)!;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();
    const p = prisma as never;
    const scope = new ScopeService(p, {} as never);
    const refs = new RecordRefsService(p, scope);
    const links = new RecordLinksService(p, refs);
    const validator = new RecordValidator(p, scope, refs);
    const presenter = new RecordPresenter(p, scope, refs);
    const records = new CustomRecordsService(p, scope, validator, presenter, links);
    const recordLists = new CustomRecordsListService(p, scope, presenter);
    deps = { prisma: p, scope, validator, records, refs, links, recordLists } as unknown as ActionDeps;
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE record_links, integration_events, custom_records, custom_fields, custom_views, custom_objects, users RESTART IDENTITY CASCADE');
    const u = await prisma.user.create({ data: { email: 'admin@t.vn', password_hash: 'x', full_name: 'Admin' } });
    user = { userId: u.id, email: u.email, isAdmin: true, grants: GRANTS };
    const kh = await prisma.customObject.create({ data: { key: 'khach_than_thiet', label: 'Khách thân thiết', label_plural: 'Khách thân thiết' } });
    const hd = await prisma.customObject.create({ data: { key: 'hop_dong', label: 'Hợp đồng', label_plural: 'Hợp đồng' } });
    await prisma.customField.createMany({ data: [
      { object_id: kh.id, key: 'ten', label: 'Tên', type: 'text', is_title: true, required: true },
      { object_id: kh.id, key: 'ma_kh', label: 'Mã KH', type: 'text', is_unique: true },
      { object_id: hd.id, key: 'so_hd', label: 'Số HĐ', type: 'text', is_title: true },
      { object_id: hd.id, key: 'khach', label: 'Khách', type: 'relation', required: true, options: { target_object_id: kh.id } },
      { object_id: hd.id, key: 'ghi_chu', label: 'Ghi chú', type: 'long_text' },
      { object_id: hd.id, key: 'lien_quan', label: 'Liên quan', type: 'link' },
    ] });
  });

  it('import nhiều bảng: con ghép cha theo khoá nghiệp vụ trong CÙNG lượt — một lần duyệt ghi cả hai', async () => {
    const prep = await act('import_records').prepare({ tables: [
      { object: 'khach_than_thiet', rows: [{ ten: 'Nguyễn An', ma_kh: 'C001' }, { ten: 'Trần Bình', ma_kh: 'C002' }] },
      { object: 'hop_dong', rows: [{ so_hd: 'HD-1', khach: { ma_kh: 'c001' }, ghi_chu: 'Tái tục cho @KTT002' }, { so_hd: 'HD-2', khach: { ma_kh: 'C999' } }] },
    ], source: 'Sheet thử' }, { deps, user });
    expect(prep.summary).toContain('2 Khách thân thiết + 1 Hợp đồng');
    expect(JSON.stringify(prep.details)).toContain('C999');
    const res = await act('import_records').execute(prep.params, { deps, user }, 1);
    expect(res).toMatchObject({ created: 3, tables: [{ object: 'khach_than_thiet', codes: 'KTT001, KTT002' }, { object: 'hop_dong', codes: 'HD001' }] });
    const hd = await prisma.customRecord.findFirstOrThrow({ where: { code: 'HD001' } });
    const an = await prisma.customRecord.findFirstOrThrow({ where: { code: 'KTT001' } });
    expect((hd.data as Record<string, unknown>).khach).toBe(an.id);
    // @KTT002 trong ghi chú đã thành cạnh liên kết.
    expect(await prisma.recordLink.count({ where: { source_id: hd.id, source_field: 'ghi_chu' } })).toBe(1);
  });

  it('bảng cha đã có trong DB: ghép bằng mã hoặc khoá; bảng sau lỗi ⇒ bảng trước không ghi nửa vời', async () => {
    await writeTables(deps, user, [{ object: 'khach_than_thiet', rows: [{ ten: 'Lê Cường', ma_kh: 'C010' }] }]);
    const prep = await act('import_records').prepare({ object: 'hop_dong', rows: [{ so_hd: 'HD-9', khach: 'KTT001' }, { so_hd: 'HD-10', khach: { ma_kh: 'C010' } }] }, { deps, user });
    expect((prep.params.rows as Record<string, unknown>[]).map((r) => r.khach)).toEqual([1, 1]);
    const before = await prisma.customRecord.count();
    await expect(writeTables(deps, user, [{ object: 'khach_than_thiet', rows: [{ ten: 'Mới', ma_kh: 'C020' }] }, { object: 'hop_dong', rows: [{ so_hd: 'X' }] }])).rejects.toThrow(/không còn hợp lệ/);
    expect(await prisma.customRecord.count()).toBe(before);
  });

  it('find_by_code + get_record theo mã + link_records', async () => {
    await writeTables(deps, user, [{ object: 'khach_than_thiet', rows: [{ ten: 'Nguyễn An', ma_kh: 'C001' }, { ten: 'Trần Bình', ma_kh: 'C002' }] }]);
    await writeTables(deps, user, [{ object: 'hop_dong', rows: [{ so_hd: 'HD-1', khach: 'KTT001' }] }]);
    const principal = { user, userId: user.userId };
    const found = await tool('find_by_code').run({ codes: ['ktt1', 'HD001', 'ZZ001'] }, { deps: deps as never, principal: principal as never, baseUrl: 'https://crm.x' });
    expect(found.structured).toMatchObject({ data: { found: [{ code: 'KTT001', object: 'khach_than_thiet', title: 'Nguyễn An', open_at: 'https://crm.x/x/khach_than_thiet/1' }, { code: 'HD001', object: 'hop_dong' }], not_found: ['ZZ001'] } });
    const rec = await tool('get_record').run({ code: 'HD001' }, { deps: deps as never, principal: principal as never, baseUrl: '' });
    expect(rec.structured).toMatchObject({ data: { object: 'hop_dong', code: 'HD001', title: 'HD-1' } });
    const prep = await act('link_records').prepare({ source: 'HD001', targets: ['KTT001', 'KTT002'] }, { deps, user });
    expect(prep.summary).toContain('HD001');
    await act('link_records').execute(prep.params, { deps, user }, 2);
    const hd = await prisma.customRecord.findFirstOrThrow({ where: { code: 'HD001' } });
    expect((hd.data as Record<string, unknown>).lien_quan).toEqual(['record:1', 'record:2']);
    await expect(act('link_records').prepare({ source: 'HD001', targets: ['KTT001'] }, { deps, user })).rejects.toThrow(/Không có thay đổi/);
  });
});
