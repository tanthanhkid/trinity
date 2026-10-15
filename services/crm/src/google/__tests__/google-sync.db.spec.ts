/**
 * Kiểm thử tích hợp có DB thật (PostgreSQL) + Google GIẢ. Chỉ chạy khi có TEST_DATABASE_URL
 * (DB đã `prisma migrate deploy`), vd: TEST_DATABASE_URL=postgresql://localhost:5432/crm_test pnpm test google-sync.db
 * Không có biến này ⇒ cả file bị bỏ qua (CI không có DB không bị đỏ).
 */
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { encryptSecret } from '../../integrations/webhooks/secret-crypto';
import { PublicApiService } from '../../public-api/public-api.service';
import { GoogleOAuthService } from '../google-oauth.service';
import { GoogleSheetsApi } from '../google-sheets-api';
import { GoogleSyncService } from '../google-sync.service';
import { SheetExportService } from '../sheet-export.service';
import { SheetImportContacts } from '../sheet-import-contacts';
import { SheetImportCustom } from '../sheet-import-custom';
import { FakeGoogleHttp } from './fake-google';
import { useDbSpecLock } from '../../test-utils/db-spec-lock';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const KEY = randomBytes(32);
const SHEET_ID = 'A'.repeat(30);

d('Đồng bộ Google Sheet — DB thật + Google giả', () => {
  useDbSpecLock(url as string);
  let prisma: PrismaClient;
  let http: FakeGoogleHttp;
  let svc: GoogleSyncService;
  let userId: number;
  let connId: number;
  const customStub = { create: jest.fn(), update: jest.fn() };

  beforeAll(async () => {
    process.env.INTEGRATIONS_SECRET_KEY = KEY.toString('base64');
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'cs';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://x.test/cb';
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();
  });
  afterAll(async () => { await prisma?.$disconnect(); });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE google_sheet_sync_runs, google_sheet_syncs, google_connections, integration_events, custom_records, custom_fields, custom_objects, activities, contacts, users RESTART IDENTITY CASCADE');
    userId = (await prisma.user.create({ data: { email: 'sale@t.vn', password_hash: 'x', full_name: 'Sale' } })).id;
    connId = (await prisma.googleConnection.create({ data: { google_email: 'o@t.vn', refresh_token_enc: encryptSecret('RT', KEY), access_token_enc: encryptSecret('AT', KEY), token_expires_at: new Date(Date.now() + 3600_000), scopes: [], created_by: userId } })).id;
    http = new FakeGoogleHttp();
    const p = prisma as never;
    const api = new GoogleSheetsApi(http);
    const publicApi = new PublicApiService(p);
    const permissions = { grantsFor: async () => ({ grants: {}, isAdmin: true }) } as never;
    const scope = { ownerIds: async () => 'all' } as never;
    svc = new GoogleSyncService(p, new GoogleOAuthService(p, http), api, new SheetImportContacts(p, publicApi, permissions, scope), new SheetImportCustom(p, {} as never, customStub as never), new SheetExportService(p, api), permissions);
    customStub.create.mockReset();
    customStub.update.mockReset();
  });

  const newSync = (over: Record<string, unknown>) => prisma.googleSheetSync.create({
    data: { name: 's', direction: 'import', connection_id: connId, spreadsheet_id: SHEET_ID, sheet_title: 'Khách', target_kind: 'contact', column_map: { phone: 'SĐT', full_name: 'Họ tên', email: 'Email' }, dedupe_key: 'phone', actor_user_id: userId, created_by: userId, ...over } as never,
  });

  it('NHẬP khách: tạo mới + cập nhật + gộp trùng + bỏ dòng sai; chạy lại không đổi gì (idempotent)', async () => {
    await prisma.contact.create({ data: { phone: '0912345678', full_name: 'Cũ', assigned_to: userId } });
    http.tabs['Khách'] = [
      ['SĐT', 'Họ tên', 'Email'],
      ['0912345678', 'An Mới', ''],          // khách đã có → cập nhật tên, ô email trống KHÔNG xoá gì
      ['+84 987 654 321', 'Bình', 'B@x.vn'],  // mới
      ['0987654321', 'Bình trùng', ''],      // trùng trong file
      ['không phải số', 'Sai', ''],          // dòng sai
    ];
    const s = await newSync({});
    const st = await svc.execute(s.id, 'manual');
    expect(st).toMatchObject({ read: 4, created: 1, updated: 1, duplicates_in_sheet: 1, invalid: 1, errors: 0 });
    const names = (await prisma.contact.findMany({ orderBy: { id: 'asc' } })).map((c) => [c.phone, c.full_name, c.email]);
    expect(names).toEqual([['0912345678', 'An Mới', null], ['0987654321', 'Bình', 'b@x.vn']]);
    const ev = await prisma.integrationEvent.findMany({ orderBy: { id: 'asc' } });
    expect(ev.map((e) => e.event_type)).toEqual(['contact.updated', 'contact.created']);
    expect((ev[1].payload as { origin: string }).origin).toBe('google_sheet_import');
    const again = await svc.execute(s.id, 'manual');
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    expect(await prisma.contact.count()).toBe(2);
    const runs = await svc.runs(s.id);
    expect(runs.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(JSON.stringify(runs, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('0987'); // nhật ký không chứa SĐT
  });

  it('NHẬP: Sheet đổi tên cột ⇒ chạy lỗi rõ ràng, không ghi gì', async () => {
    http.tabs['Khách'] = [['Phone', 'Họ tên'], ['0912345678', 'An']];
    const s = await newSync({});
    await expect(svc.execute(s.id, 'manual')).rejects.toThrow(/thiếu cột/);
    expect(await prisma.contact.count()).toBe(0);
    expect((await prisma.googleSheetSync.findUniqueOrThrow({ where: { id: s.id } })).last_status).toBe('error');
  });

  it('NHẬP bản ghi tuỳ biến: tìm theo khoá khử trùng (SQL thật), gọi create/update với dữ liệu ô', async () => {
    const obj = await prisma.customObject.create({ data: { key: 'hoc_sinh', label: 'Học sinh', label_plural: 'Học sinh' } });
    await prisma.customRecord.create({ data: { object_id: obj.id, data: { ma: 'HS01', ten: 'Cũ' }, title: 'Cũ' } });
    jest.spyOn(SheetImportCustom.prototype as never, 'actor' as never).mockResolvedValue({ userId } as never);
    http.tabs['HS'] = [['Mã', 'Tên'], ['hs01', 'An'], ['HS02', 'Bình']];
    const s = await newSync({ sheet_title: 'HS', target_kind: 'custom_object', target_object_key: 'hoc_sinh', column_map: { ma: 'Mã', ten: 'Tên' }, dedupe_key: 'ma' });
    const st = await svc.execute(s.id, 'manual');
    expect(st).toMatchObject({ created: 1, updated: 1, errors: 0 });
    expect(customStub.update).toHaveBeenCalledWith({ userId }, 'hoc_sinh', expect.any(Number), { data: { ma: 'hs01', ten: 'An' } });
    expect(customStub.create).toHaveBeenCalledWith({ userId }, 'hoc_sinh', { data: { ma: 'HS02', ten: 'Bình' } });
  });

  it('XUẤT: chỉ khách MỚI sau khi bật, tiêu đề ghi 1 lần, không xuất lại; khách do NHẬP tạo bị bỏ (chống vòng lặp)', async () => {
    const old = await prisma.contact.create({ data: { phone: '0900000001', full_name: 'Trước khi bật', assigned_to: userId } });
    void old;
    const exporter = new SheetExportService(prisma as never, new GoogleSheetsApi(http));
    const s = await newSync({ direction: 'export', sheet_title: 'Ra', column_map: { phone: 'SĐT', full_name: 'Họ tên' }, dedupe_key: 'id', export_cursor: await exporter.currentCursor() });
    http.tabs['Ra'] = [];
    const publicApi = new PublicApiService(prisma as never);
    await prisma.$transaction((tx) => publicApi.createContactInTx(tx, { phone: '0911111111', full_name: 'Mới 1' }, { id: userId, team_id: null }, 'public_api'));
    await prisma.$transaction((tx) => publicApi.createContactInTx(tx, { phone: '0922222222', full_name: 'Từ Sheet' }, { id: userId, team_id: null }, 'google_sheet_import'));
    const st = await svc.execute(s.id, 'manual');
    expect(st.created).toBe(1);
    expect(http.tabs['Ra']).toEqual([['SĐT', 'Họ tên'], ['0911111111', 'Mới 1']]);
    expect(await svc.execute(s.id, 'manual')).toMatchObject({ created: 0, read: 0 });
    expect(http.tabs['Ra']).toHaveLength(2);
  });

  it('XUẤT backfill: đẩy cả khách hiện có; sự kiện cũ không bị xuất lặp sau đó', async () => {
    await prisma.contact.create({ data: { phone: '0900000001', full_name: 'A', assigned_to: userId } });
    await prisma.contact.create({ data: { phone: '0900000002', full_name: 'B', assigned_to: userId } });
    const s = await newSync({ direction: 'export', sheet_title: 'Ra', column_map: { phone: 'SĐT', full_name: 'Họ tên' }, dedupe_key: 'id' });
    http.tabs['Ra'] = [];
    const st = await svc.execute(s.id, 'manual', { backfill: true });
    expect(st.created).toBe(2);
    expect(http.tabs['Ra'].map((r) => r[0])).toEqual(['SĐT', '0900000001', '0900000002']);
  });

  it('không chạy chồng; due() theo chu kỳ', async () => {
    http.tabs['Khách'] = [['SĐT', 'Họ tên', 'Email']];
    const s = await newSync({ schedule_minutes: 10 });
    expect(await svc.due()).toEqual([s.id]);
    await svc.execute(s.id, 'schedule');
    expect(await svc.due()).toEqual([]);
    expect(await svc.due(new Date(Date.now() + 11 * 60_000))).toEqual([s.id]);
    await prisma.googleSheetSyncRun.create({ data: { sync_id: s.id, trigger: 'manual' } }); // đang chạy dở
    await expect(svc.execute(s.id, 'manual')).rejects.toThrow(/đang chạy/);
  });
});
