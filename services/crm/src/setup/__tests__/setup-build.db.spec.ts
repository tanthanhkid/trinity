/**
 * Dựng hệ thống theo loại doanh nghiệp + bản ghi MẪU tự xoá — DB THẬT. Chỉ chạy khi có TEST_DATABASE_URL (DB đã `prisma migrate deploy`), vd:
 * TEST_DATABASE_URL=postgresql://localhost:5432/trinity_onboarding_test pnpm --filter @trinity/crm test setup-build.db
 * Không có biến này ⇒ bỏ qua cả file.
 */
import { PrismaClient } from '@prisma/client';
import type { Grants } from '@trinity/rbac';
import { ScopeService, type AuthUser } from '@trinity/rbac-nest';
import { CustomObjectTemplatesService } from '../../custom-objects/custom-object-templates.service';
import { CustomRecordsService } from '../../custom-objects/custom-records.service';
import { RecordPresenter } from '../../custom-objects/record-presenter.service';
import { RecordValidator } from '../../custom-objects/record-validator.service';
import { RecordLinksService } from '../../custom-objects/refs/record-links.service';
import { RecordRefsService } from '../../custom-objects/refs/record-refs.service';
import { SampleRecordsService, SAMPLE_RECORDS_KEY } from '../../sample-records/sample-records.service';
import { OrgFeaturesService } from '../../settings/org-features.service';
import { useDbSpecLock } from '../../test-utils/db-spec-lock';
import { SetupBuildService } from '../setup-build.service';
import { SetupStatusService } from '../setup-status.service';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const ADMIN = {
  'custom_records.view': 'all', 'custom_records.manage': 'all', 'custom_records.delete': 'all', 'contacts.view': 'all',
  'custom_objects.manage': true, 'settings.features': true,
} as unknown as Grants;

d('Dựng hệ thống + bản ghi mẫu — DB thật', () => {
  useDbSpecLock(url as string);
  let prisma: PrismaClient;
  let build: SetupBuildService;
  let samples: SampleRecordsService;
  let records: CustomRecordsService;
  let features: OrgFeaturesService;
  let admin: AuthUser;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();
    const p = prisma as never;
    const scope = new ScopeService(p, {} as never);
    const refs = new RecordRefsService(p, scope);
    samples = new SampleRecordsService(p);
    const setup = new SetupStatusService(p);
    features = new OrgFeaturesService(p, setup);
    build = new SetupBuildService(p, new CustomObjectTemplatesService(p, samples), features, setup, samples);
    records = new CustomRecordsService(p, scope, new RecordValidator(p, scope, refs), new RecordPresenter(p, scope, refs), new RecordLinksService(p, refs), samples);
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE record_links, integration_events, custom_records, custom_fields, custom_views, custom_objects, contacts, settings, users RESTART IDENTITY CASCADE');
    await prisma.$executeRawUnsafe('ALTER SEQUENCE contacts_code_seq RESTART WITH 1');
    const a = await prisma.user.create({ data: { email: 'admin@t.vn', password_hash: 'x', full_name: 'Admin' } });
    admin = { userId: a.id, email: a.email, isAdmin: true, grants: ADMIN };
  });

  const liveRecords = () => prisma.customRecord.count({ where: { deleted_at: null } });
  const liveContacts = () => prisma.contact.count({ where: { deleted_at: null } });

  it('ngành Giáo dục: tạo bảng mẫu + 3 bản ghi mẫu (bảng đầu), lưu ngành/phân hệ, trạng thái đã dựng', async () => {
    const r = await build.build(admin, { industry: 'education_center', features: ['pos'] });
    expect(r.created_objects).toEqual(['phu_huynh', 'hoc_sinh', 'khoa_hoc', 'hoa_don', 'ghi_danh', 'thanh_toan']);
    expect(r.sample_records).toBe(3);
    expect(await liveRecords()).toBe(3);
    expect(await liveContacts()).toBe(0);
    expect(r.features).toEqual(expect.arrayContaining(['dashboard', 'contacts', 'kanban', 'reports', 'pos']));
    const f = await features.get();
    expect(f.pos).toBe(true);
    expect(f.payroll).toBe(false);
    expect((await prisma.setting.findUnique({ where: { key: 'setup_industry' } }))?.value).toBe('education_center');
    expect((await prisma.setting.findUnique({ where: { key: 'setup_status' } }))?.value).toBe('da_dung');
    expect(await build.isBuilt()).toBe(true);
    expect(await samples.read()).toMatchObject({ contacts: [], records: expect.any(Array) });
  });

  it('tạo bản ghi tuỳ biến THẬT đầu tiên (qua service như UI/API/MCP) ⇒ mẫu tự xoá, dòng theo dõi biến mất', async () => {
    await build.build(admin, { industry: 'education_center' });
    expect(await liveRecords()).toBe(3);
    await records.create(admin, 'phu_huynh', { data: { ho_ten: 'Phụ huynh thật' } });
    expect(await liveRecords()).toBe(1);
    const left = await prisma.customRecord.findMany({ where: { deleted_at: null } });
    expect(left[0].title).toBe('Phụ huynh thật');
    expect(await prisma.setting.findUnique({ where: { key: SAMPLE_RECORDS_KEY } })).toBeNull();
  });

  it('ngành "Khác": 3 khách mẫu, không có bảng tuỳ biến; khách THẬT (tạo trực tiếp) + lưới an toàn ⇒ mẫu xoá', async () => {
    const r = await build.build(admin, { industry: 'other' });
    expect(r.created_objects).toEqual([]);
    expect(r.sample_contacts).toBe(3);
    expect(await liveContacts()).toBe(3);
    expect(await prisma.customObject.count()).toBe(0);
    expect(await samples.purgeIfReal()).toBe(false); // chưa có khách thật ⇒ giữ mẫu
    expect(await liveContacts()).toBe(3);
    await prisma.contact.create({ data: { phone: '0988123456', full_name: 'Khách thật', assigned_to: admin.userId } });
    expect(await samples.purgeIfReal()).toBe(true);
    const left = await prisma.contact.findMany({ where: { deleted_at: null } });
    expect(left.map((c) => c.full_name)).toEqual(['Khách thật']);
    expect(await prisma.setting.findUnique({ where: { key: SAMPLE_RECORDS_KEY } })).toBeNull();
  });

  it('người dùng tự xoá hết mẫu rồi mới tạo bản ghi thật: không lỗi, không xoá nhầm bản ghi thật', async () => {
    await build.build(admin, { industry: 'clinic' });
    await prisma.customRecord.updateMany({ data: { deleted_at: new Date() } });
    await records.create(admin, 'pk_benh_nhan', { data: { ten: 'Bệnh nhân thật' } });
    expect(await liveRecords()).toBe(1);
  });

  it('dựng lại (chạy lại) không nhân đôi bảng và không sinh thêm mẫu', async () => {
    await build.build(admin, { industry: 'real_estate' });
    const n = await liveRecords();
    const again = await build.build(admin, { industry: 'real_estate', features: ['inbox'] });
    expect(again.created_objects).toEqual([]);
    expect(again.sample_records).toBe(0);
    expect(await liveRecords()).toBe(n);
    expect(await prisma.customObject.count()).toBe(4);
  });

  it('đã có khách thật thì dựng không chèn dữ liệu mẫu', async () => {
    await prisma.contact.create({ data: { phone: '0977000111', full_name: 'Khách cũ', assigned_to: admin.userId } });
    const r = await build.build(admin, { industry: 'retail_service' });
    expect(r.sample_records).toBe(0);
    expect(r.sample_contacts).toBe(0);
    expect(await liveRecords()).toBe(0);
    expect(await prisma.setting.findUnique({ where: { key: SAMPLE_RECORDS_KEY } })).toBeNull();
  });

  it('ngành lạ / thiếu quyền bị từ chối', async () => {
    await expect(build.build(admin, { industry: 'f_and_b' })).rejects.toThrow(/không hợp lệ/);
    const nobody: AuthUser = { ...admin, grants: {} as Grants };
    await expect(build.build(nobody, { industry: 'other' })).rejects.toThrow(/quản trị/);
  });

  it('dựng lại giữ built_at lần đầu; không truyền features thì giữ phân hệ admin đã bật thêm', async () => {
    await build.build(admin, { industry: 'clinic' });
    const first = JSON.parse((await prisma.setting.findUnique({ where: { key: 'setup_built' } }))!.value).built_at;
    await features.update({ payroll: true } as never, admin.userId);
    await new Promise((r) => setTimeout(r, 20));
    await build.build(admin, { industry: 'clinic' });
    expect(JSON.parse((await prisma.setting.findUnique({ where: { key: 'setup_built' } }))!.value).built_at).toBe(first);
    expect((await features.get()).payroll).toBe(true);
    expect((await features.get()).pos).toBe(false);
    // có features thì thay đúng theo danh sách
    await build.build(admin, { industry: 'clinic', features: ['inbox'] });
    const f = await features.get();
    expect(f.payroll).toBe(false);
    expect(f.inbox).toBe(true);
  });

  it('mẫu người dùng đã sửa, hoặc bị bản ghi thật liên kết tới, được GIỮ (thành dữ liệu thật); mẫu còn nguyên bị xoá', async () => {
    await build.build(admin, { industry: 'education_center' });
    const rows = await prisma.customRecord.findMany({ orderBy: { id: 'asc' } });
    expect(rows).toHaveLength(3);
    // sửa mẫu 1 (lùi created_at để vượt ngưỡng chỉnh sửa)
    await prisma.customRecord.update({ where: { id: rows[0].id }, data: { created_at: new Date(Date.now() - 60_000), title: 'Đã sửa' } });
    // bản ghi THẬT (học sinh) liên kết tới mẫu 2 ⇒ lần tạo này kích hoạt dọn mẫu
    await records.create(admin, 'hoc_sinh', { data: { ho_ten: 'HS thật', phu_huynh: rows[1].id } });
    const live = await prisma.customRecord.findMany({ where: { deleted_at: null }, select: { id: true } });
    expect(live.map((r) => r.id)).toEqual(expect.arrayContaining([rows[0].id, rows[1].id]));
    expect(live).toHaveLength(3); // mẫu 1 (đã sửa) + mẫu 2 (được liên kết) + học sinh thật
    expect(live.map((r) => r.id)).not.toContain(rows[2].id);
    expect(await prisma.setting.findUnique({ where: { key: SAMPLE_RECORDS_KEY } })).toBeNull();
  });

  it('hai lần dựng "Khác" đồng thời không tạo mẫu trùng, không mất id mẫu', async () => {
    await Promise.all([build.build(admin, { industry: 'other' }), build.build(admin, { industry: 'other' })]);
    expect(await liveContacts()).toBe(3);
    expect((await samples.read())?.contacts).toHaveLength(3);
  });

  it('dọn mẫu: id đăng ký giữa chừng (sau lúc đọc) không bị mất theo dõi; dòng chỉ xoá khi rỗng', async () => {
    await build.build(admin, { industry: 'other' });
    const priv = samples as unknown as { untouched: (...a: unknown[]) => Promise<unknown> };
    const orig = priv.untouched.bind(samples);
    const extra = 999_999;
    const spy = jest.spyOn(priv, 'untouched').mockImplementation(async (...a: unknown[]) => {
      const r = await orig(...a);
      // Giả lập một id mẫu được ghi vào danh sách NGAY SAU lúc dọn đọc nó (trong transaction), trước khi dọn ghi lại dòng theo dõi.
      const cur = JSON.parse((await prisma.setting.findUnique({ where: { key: SAMPLE_RECORDS_KEY } }))!.value);
      await prisma.setting.update({ where: { key: SAMPLE_RECORDS_KEY }, data: { value: JSON.stringify({ ...cur, records: [...cur.records, extra] }) } });
      return r;
    });
    await prisma.contact.create({ data: { phone: '0988000111', full_name: 'Khách thật', assigned_to: admin.userId } });
    expect(await samples.purgeIfReal()).toBe(true);
    spy.mockRestore();
    expect(await liveContacts()).toBe(1);
    expect(await samples.read()).toEqual({ contacts: [], records: [extra] }); // id đăng ký sau vẫn được theo dõi
  });

  it('purgeIfReal không có dòng sample_records ⇒ trả ngay, KHÔNG mở transaction/khoá', async () => {
    const tx = jest.spyOn(prisma, '$transaction');
    expect(await samples.purgeIfReal()).toBe(false);
    expect(tx).not.toHaveBeenCalled();
    tx.mockRestore();
  });

  it('dựng lại "Khác" sau khi mẫu đã bị dọn KHÔNG tạo khách mẫu mới (cờ samples_seeded)', async () => {
    await build.build(admin, { industry: 'other' });
    await prisma.contact.create({ data: { phone: '0988222333', full_name: 'Khách thật', assigned_to: admin.userId } });
    await samples.purgeIfReal();
    expect(await liveContacts()).toBe(1);
    await prisma.contact.updateMany({ where: { full_name: 'Khách thật' }, data: { deleted_at: new Date() } });
    const again = await build.build(admin, { industry: 'other' });
    expect(again.sample_contacts).toBe(0);
    expect(await liveContacts()).toBe(0);
    expect(JSON.parse((await prisma.setting.findUnique({ where: { key: 'setup_built' } }))!.value).samples_seeded).toBe(true);
  });

  it('nhiều bản ghi thật có relation: chỉ bản ghi trỏ tới mẫu mới giữ mẫu lại (truy vấn jsonb, không tải hết)', async () => {
    await build.build(admin, { industry: 'education_center' });
    const rows = await prisma.customRecord.findMany({ orderBy: { id: 'asc' } });
    // 300 học sinh thật không trỏ tới phụ huynh nào + 1 trỏ tới mẫu thứ 3 (mảng/giá trị đơn đều được dò)
    const obj = await prisma.customObject.findFirstOrThrow({ where: { key: 'hoc_sinh' } });
    await prisma.customRecord.createMany({ data: Array.from({ length: 300 }, (_, i) => ({ object_id: obj.id, title: `HS ${i}`, data: { ho_ten: `HS ${i}` }, owner_id: admin.userId, created_by: admin.userId })) });
    await records.create(admin, 'hoc_sinh', { data: { ho_ten: 'HS trỏ mẫu', phu_huynh: rows[2].id } });
    const live = await prisma.customRecord.findMany({ where: { deleted_at: null, id: { in: rows.map((r) => r.id) } } });
    expect(live.map((r) => r.id)).toEqual([rows[2].id]);
  });

  it('R1: hỏng giữa chừng ⇒ rollback cả bảng, vẫn chua_dung, wizard chưa coi là đã dựng và dựng lại được', async () => {
    await prisma.setting.upsert({ where: { key: 'setup_status' }, update: { value: 'chua_dung' }, create: { key: 'setup_status', value: 'chua_dung' } });
    // Giả lập lỗi SAU khi bảng + mẫu + phân hệ đã ghi trong transaction (bước ghi dấu đã dựng).
    const tpl = (build as unknown as { templates: CustomObjectTemplatesService }).templates;
    const realApply = tpl.apply.bind(tpl);
    jest.spyOn(tpl, 'apply').mockImplementationOnce((u, k, w, o = {}) => realApply(u, k, w, { ...o, after: async (tx, res) => { await o.after!(tx, res); throw new Error('boom'); } }));
    await expect(build.build(admin, { industry: 'clinic' })).rejects.toThrow('boom');
    expect(await prisma.customObject.count()).toBe(0);
    expect(await prisma.customRecord.count()).toBe(0);
    expect(await build.isBuilt()).toBe(false);
    expect((await prisma.setting.findUnique({ where: { key: 'setup_status' } }))?.value).toBe('chua_dung');
    const ok = await build.build(admin, { industry: 'clinic' });
    expect(ok.created_objects).toHaveLength(3);
    expect(await build.isBuilt()).toBe(true);
    expect((await prisma.setting.findUnique({ where: { key: 'setup_status' } }))?.value).toBe('da_dung');
  });

  it('R2: còn mẫu nhưng chưa có bản ghi thật ⇒ không mở transaction (tải trang không xếp hàng khoá)', async () => {
    await build.build(admin, { industry: 'other' });
    const tx = jest.spyOn(prisma, '$transaction');
    expect(await samples.purgeIfReal()).toBe(false);
    expect(tx).not.toHaveBeenCalled();
    tx.mockRestore();
  });

  it('R4: bảng đầu của mẫu đã có sẵn (người dùng tự tạo) ⇒ mẫu lấy từ bảng MỚI tạo kế tiếp, vẫn có bản ghi mẫu', async () => {
    await prisma.customObject.create({ data: { key: 'phu_huynh', label: 'Phụ huynh', label_plural: 'Phụ huynh' } });
    const r = await build.build(admin, { industry: 'education_center' });
    expect(r.created_objects[0]).toBe('hoc_sinh');
    expect(r.sample_records).toBeGreaterThan(0);
    const obj = await prisma.customObject.findFirstOrThrow({ where: { key: 'hoc_sinh' } });
    expect(await prisma.customRecord.count({ where: { object_id: obj.id } })).toBe(r.sample_records);
  });
});
