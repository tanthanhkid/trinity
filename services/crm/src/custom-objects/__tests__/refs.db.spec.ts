/**
 * Mã chung + gắn thẻ @ — DB THẬT (trigger cấp mã, chỉ mục, record_links). Chỉ chạy khi có TEST_DATABASE_URL (DB đã `prisma migrate
 * deploy`), vd: TEST_DATABASE_URL=postgresql://localhost:5432/trinity_ma_chung pnpm --filter @trinity/crm test refs.db
 * Không có biến này ⇒ bỏ qua cả file (CI không có DB không đỏ).
 */
import { PrismaClient } from '@prisma/client';
import type { Grants } from '@trinity/rbac';
import { ScopeService, type AuthUser } from '@trinity/rbac-nest';
import { CustomRecordsService } from '../custom-records.service';
import { renamePrefix } from '../record-codes';
import { RecordPresenter } from '../record-presenter.service';
import { RecordValidator } from '../record-validator.service';
import { loadVisibleObject } from '../custom-object-access';
import { RecordLinksService } from '../refs/record-links.service';
import { RecordRefsService } from '../refs/record-refs.service';
import { useDbSpecLock } from '../../test-utils/db-spec-lock';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const ALL = { 'custom_records.view': 'all', 'custom_records.manage': 'all', 'custom_records.delete': 'all', 'contacts.view': 'all', 'custom_objects.manage': true } as unknown as Grants;
const OWN = { 'custom_records.view': 'own', 'custom_records.manage': 'own' } as unknown as Grants;

d('Mã chung + gắn thẻ @ — DB thật', () => {
  useDbSpecLock(url as string);
  let prisma: PrismaClient;
  let refs: RecordRefsService;
  let links: RecordLinksService;
  let records: CustomRecordsService;
  let admin: AuthUser;
  let sale: AuthUser;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();
    const p = prisma as never;
    const scope = new ScopeService(p, {} as never);
    refs = new RecordRefsService(p, scope);
    links = new RecordLinksService(p, refs);
    records = new CustomRecordsService(p, scope, new RecordValidator(p, scope, refs), new RecordPresenter(p, scope, refs), links);
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE record_links, integration_events, custom_records, custom_fields, custom_views, custom_objects, contacts, users RESTART IDENTITY CASCADE');
    await prisma.$executeRawUnsafe('ALTER SEQUENCE contacts_code_seq RESTART WITH 1');
    const a = await prisma.user.create({ data: { email: 'admin@t.vn', password_hash: 'x', full_name: 'Admin' } });
    const s = await prisma.user.create({ data: { email: 'sale@t.vn', password_hash: 'x', full_name: 'Sale' } });
    admin = { userId: a.id, email: a.email, isAdmin: true, grants: ALL };
    sale = { userId: s.id, email: s.email, isAdmin: false, grants: OWN };
    const hs = await prisma.customObject.create({ data: { key: 'hoc_sinh', label: 'Học sinh', label_plural: 'Học sinh' } });
    const lh = await prisma.customObject.create({ data: { key: 'lich_hen', label: 'Lịch hẹn', label_plural: 'Lịch hẹn' } });
    await prisma.customField.createMany({ data: [
      { object_id: hs.id, key: 'ho_ten', label: 'Họ tên', type: 'text', is_title: true },
      { object_id: lh.id, key: 'ten', label: 'Tên', type: 'text', is_title: true },
      { object_id: lh.id, key: 'ghi_chu', label: 'Ghi chú', type: 'long_text' },
      { object_id: lh.id, key: 'lien_quan', label: 'Liên quan', type: 'link' },
    ] });
    for (const ho_ten of ['Nguyễn Văn An', 'Trần Bình']) await records.create(admin, 'hoc_sinh', { data: { ho_ten } });
  });

  it('tiền tố tự sinh từ tên + mã tăng dần; khách hàng KH, bảng tuỳ biến không lấy được KH', async () => {
    const objs = await prisma.customObject.findMany({ orderBy: { id: 'asc' }, select: { code_prefix: true } });
    expect(objs.map((o) => o.code_prefix)).toEqual(['HS', 'LH']);
    expect((await prisma.customRecord.findMany({ orderBy: { id: 'asc' }, select: { code: true } })).map((r) => r.code)).toEqual(['HS001', 'HS002']);
    const kh = await prisma.customObject.create({ data: { key: 'khach', label: 'Khách hàng', label_plural: 'Khách hàng' } });
    expect(kh.code_prefix).toBe('KHA');
    const c = await prisma.contact.create({ data: { phone: '0900000001', full_name: 'Khách A' } });
    expect(c.code).toBe('KH001');
  });

  it('gợi ý @: theo đầu mã, theo tên, mã đầy đủ', async () => {
    expect((await refs.suggest(admin, '@HS')).map((v) => v.code)).toEqual(['HS001', 'HS002']);
    expect((await refs.suggest(admin, 'Nguyễn'))[0]).toMatchObject({ code: 'HS001', title: 'Nguyễn Văn An', table: 'Học sinh', href: '/x/hoc_sinh/1' });
    expect((await refs.suggest(admin, 'bình'))[0]?.code).toBe('HS002');
    expect((await refs.suggest(admin, 'nguyen'))[0]).toMatchObject({ code: 'HS001', title: 'Nguyễn Văn An' });
    expect((await refs.suggest(admin, 'binh'))[0]?.code).toBe('HS002');
    expect((await refs.suggest(admin, 'hs002'))[0]?.code).toBe('HS002');
  });

  it('lưu ghi chú có @ + trường Liên kết ⇒ cạnh record_links; truy ngược "Được nhắc tới ở"', async () => {
    const r = await records.create(admin, 'lich_hen', { data: { ten: 'Khám định kỳ', ghi_chu: 'Khám cho @hs001, gọi phụ huynh @HS999 (không có)', lien_quan: ['HS002', 'HS001'] } });
    expect('data' in r && r.data.lien_quan).toEqual(['record:2', 'record:1']);
    expect('relations' in r && r.relations.lien_quan).toEqual([
      expect.objectContaining({ code: 'HS002', title: 'Trần Bình', accessible: true }), expect.objectContaining({ code: 'HS001', accessible: true }),
    ]);
    const edges = await prisma.recordLink.findMany({ orderBy: [{ source_field: 'asc' }, { target_id: 'asc' }], select: { source_field: true, target_id: true } });
    expect(edges).toEqual([{ source_field: 'ghi_chu', target_id: 1 }, { source_field: 'lien_quan', target_id: 1 }, { source_field: 'lien_quan', target_id: 2 }]);
    const back = await links.backlinks(admin, { type: 'record', id: 1 });
    expect(back).toEqual([{ source: expect.objectContaining({ code: 'LH001', title: 'Khám định kỳ' }), fields: expect.arrayContaining(['Ghi chú', 'Liên quan']) }]);
    // Sửa ghi chú bỏ thẻ ⇒ cạnh của trường đó mất, trường Liên kết giữ nguyên.
    await records.update(admin, 'lich_hen', r.id, { data: { ghi_chu: 'Đã khám' } });
    expect(await prisma.recordLink.count({ where: { source_field: 'ghi_chu' } })).toBe(0);
    expect(await prisma.recordLink.count({ where: { source_field: 'lien_quan' } })).toBe(2);
  });

  it('tôn trọng quyền xem: người chỉ thấy bản ghi của mình không gợi ý / gắn được bản ghi người khác', async () => {
    expect(await refs.suggest(sale, '@HS')).toEqual([]);
    expect((await refs.resolveCodes(sale, ['HS001'])).size).toBe(0);
    await expect(records.create(sale, 'lich_hen', { data: { ten: 'X', lien_quan: ['HS001'] } })).rejects.toThrow(/không hợp lệ/);
    await expect(links.backlinks(sale, { type: 'record', id: 1 })).rejects.toThrow(/Không tìm thấy/);
  });

  it('đổi tiền tố: mã đổi theo, mã cũ vẫn tra được; xoá bản ghi không dùng lại số', async () => {
    const def = await loadVisibleObject(prisma as never, admin, 'hoc_sinh');
    await renamePrefix(prisma as never, def.obj.id, 'HV');
    expect((await refs.suggest(admin, 'HV')).map((v) => v.code)).toEqual(['HV001', 'HV002']);
    expect((await refs.resolveCodes(admin, ['HS002'])).get('HS002')).toMatchObject({ code: 'HV002', title: 'Trần Bình' });
    await records.remove(admin, 'hoc_sinh', 2);
    const n = await records.create(admin, 'hoc_sinh', { data: { ho_ten: 'Lê Cường' } });
    expect('code' in n && n.code).toBe('HV003');
  });
});
