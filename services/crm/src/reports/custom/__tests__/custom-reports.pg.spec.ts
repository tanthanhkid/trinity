import type { PrismaService } from '@trinity/prisma';
import { adminGrants, type AuthUser } from '@trinity/rbac-nest';
import { describePg, pgClient, resetTables } from '../../../__pg__/pg-harness';
import { CustomReportsService } from '../custom-reports.service';

const TABLES = ['settings', 'custom_records', 'custom_fields', 'custom_objects', 'deals', 'contacts', 'users'];
const admin: AuthUser = { userId: 1, email: 'a@x.vn', isAdmin: true, grants: adminGrants() };

describePg('Báo cáo dùng chung (#25) trên Postgres thật', () => {
  let db: PrismaService;
  let owners: number[] | 'all' = 'all';
  let svc: CustomReportsService;
  let hs: { id: number };

  beforeAll(() => {
    db = pgClient();
    svc = new CustomReportsService(db, { ownerIds: async () => owners } as never);
  });
  beforeEach(async () => {
    owners = 'all';
    await resetTables(db, TABLES);
    await db.user.createMany({ data: [{ id: 1, email: 'a@x.vn', password_hash: 'x', full_name: 'Quản trị' }, { id: 2, email: 'b@x.vn', password_hash: 'x', full_name: 'Lan' }] });
    hs = await db.customObject.create({ data: { key: 'hoc_sinh', label: 'Học sinh', label_plural: 'Học sinh' } });
    const tt = await db.customObject.create({ data: { key: 'thanh_toan', label: 'Thanh toán', label_plural: 'Thanh toán' } });
    await db.customField.createMany({ data: [
      { object_id: tt.id, key: 'ngay_tt', label: 'Ngày thanh toán', type: 'date' },
      { object_id: tt.id, key: 'so_tien', label: 'Số tiền', type: 'currency' },
      { object_id: tt.id, key: 'hinh_thuc', label: 'Hình thức', type: 'select', options: { choices: [{ value: 'ck', label: 'Chuyển khoản' }, { value: 'tm', label: 'Tiền mặt' }] } },
      { object_id: tt.id, key: 'hoc_sinh', label: 'Học sinh', type: 'relation', options: { target_object_id: hs.id } },
    ] });
    const an = await db.customRecord.create({ data: { object_id: hs.id, title: 'An', data: {}, owner_id: 1, created_by: 1 } });
    const rec = (data: object, owner: number) => db.customRecord.create({ data: { object_id: tt.id, title: 'TT', data: { ...data, hoc_sinh: an.id }, owner_id: owner, created_by: owner } });
    await rec({ ngay_tt: '2026-09-05', so_tien: 1500000, hinh_thuc: 'ck' }, 1);
    await rec({ ngay_tt: '2026-09-20', so_tien: '500000', hinh_thuc: 'tm' }, 2);
    await rec({ ngay_tt: '2026-10-02', so_tien: 2000000, hinh_thuc: 'ck' }, 1);
    await rec({ ngay_tt: 'sai-ngay', so_tien: 'abc' }, 1);
    await rec({ so_tien: 100 }, 1);
    await db.deal.createMany({ data: [
      { title: 'D1', value: 10_000_000n, status: 'won', assigned_to: 2, created_by: 1, created_at: new Date('2026-09-10T03:00:00Z') },
      { title: 'D2', value: 5_000_000n, status: 'open', assigned_to: 2, created_by: 1, created_at: new Date('2026-09-30T18:00:00Z') }, // 01/10 giờ VN
    ] });
  });
  afterAll(() => db.$disconnect());

  const save = (reports: object[]) => svc.save(admin, reports);

  it('bảng tuỳ biến: kỳ tháng theo trường ngày nghiệp vụ, cộng tổng, nhóm theo lựa chọn, dòng thiếu ngày chỉ ở "Tất cả"', async () => {
    await save([{ id: 'thu_tien', name: 'Thu tiền', source: 'x:thanh_toan', date_field: 'ngay_tt', sum_fields: ['so_tien'], group_by: 'hinh_thuc' }]);
    const sep = await svc.run(admin, 'thu_tien', 'month:2026-09');
    expect(sep).toMatchObject({ count: 2, sums: { so_tien: 2_000_000 }, missing_date: 0, period: { label: 'Tháng 9/2026' } });
    expect(sep.groups.map((g) => [g.label, g.count, g.sums.so_tien])).toEqual([['Chuyển khoản', 1, 1_500_000], ['Tiền mặt', 1, 500_000]]);
    const year = await svc.run(admin, 'thu_tien', 'year:2026');
    expect(year.count).toBe(3);
    expect(year.by_month.map((m) => [m.month, m.count])).toEqual([['2026-09', 2], ['2026-10', 1]]);
    const all = await svc.run(admin, 'thu_tien', 'all');
    expect(all).toMatchObject({ count: 5, missing_date: 2, sums: { so_tien: 4_000_100 } });
    expect(all.groups.find((g) => g.key === null)?.label).toBe('(Trống)');
  });

  it('nhóm theo bản ghi liên kết hiện tên; phạm vi quyền thu hẹp số liệu', async () => {
    await save([{ id: 'theo_hs', name: 'Theo học sinh', source: 'x:thanh_toan', date_field: 'created_at', sum_fields: [], group_by: 'hoc_sinh' }]);
    expect((await svc.run(admin, 'theo_hs', 'all')).groups[0]).toMatchObject({ label: 'An', count: 5 });
    owners = [2];
    const mine = await svc.run(admin, 'theo_hs', 'all');
    expect(mine.count).toBe(1);
    expect(mine.groups[0].label).toBe(`#${(await db.customRecord.findFirstOrThrow({ where: { object_id: hs.id } })).id}`); // An ngoài phạm vi người xem
  });

  it('bảng lõi deal: ngày theo giờ VN, tổng giá trị, nhóm trạng thái', async () => {
    await save([{ id: 'deal', name: 'Deal', source: 'deals', date_field: 'created_at', sum_fields: ['value'], group_by: 'status' }]);
    const sep = await svc.run(admin, 'deal', 'month:2026-09');
    expect(sep).toMatchObject({ count: 1, sums: { value: 10_000_000 } });
    expect(sep.groups[0].label).toBe('Thắng');
    expect((await svc.run(admin, 'deal', 'month:2026-10')).count).toBe(1);
  });

  it('lưu: trường không đúng vai bị từ chối; không có quyền xem bảng thì không thấy báo cáo', async () => {
    await expect(save([{ id: 'x', name: 'X', source: 'x:thanh_toan', date_field: 'so_tien', sum_fields: [] }])).rejects.toThrow(/không phải trường ngày/);
    await expect(save([{ id: 'x', name: 'X', source: 'x:khong_co', date_field: 'created_at', sum_fields: [] }])).rejects.toThrow(/không có bảng nguồn/);
    await save([{ id: 'deal', name: 'Deal', source: 'deals', date_field: 'created_at', sum_fields: [] }]);
    expect((await svc.list(admin)).reports.map((r) => r.id)).toEqual(['deal']);
    svc = new CustomReportsService(db, { ownerIds: async () => null } as never);
    expect((await svc.list(admin)).reports).toEqual([]);
    await expect(svc.run(admin, 'deal', 'all')).rejects.toThrow(/Không tìm thấy/);
    svc = new CustomReportsService(db, { ownerIds: async () => owners } as never);
  });
});
