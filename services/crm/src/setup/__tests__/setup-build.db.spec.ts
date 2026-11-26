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
    const r = await build.build(admin, { industry: 'education_center', features: ['payments', 'pos'] });
    expect(r.created_objects).toEqual(['phu_huynh', 'hoc_sinh', 'khoa_hoc', 'hoa_don', 'ghi_danh', 'thanh_toan']);
    expect(r.sample_records).toBe(3);
    expect(await liveRecords()).toBe(3);
    expect(await liveContacts()).toBe(0);
    expect(r.features).toEqual(expect.arrayContaining(['dashboard', 'contacts', 'kanban', 'reports', 'payments', 'pos']));
    const f = await features.get();
    expect(f.payments).toBe(true);
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
});
