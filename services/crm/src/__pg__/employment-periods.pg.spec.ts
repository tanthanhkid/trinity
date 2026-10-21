import { Prisma, recordEmploymentEnd, recordEmploymentStart, type PrismaService } from '@trinity/prisma';
import type { AuthUser } from '@trinity/rbac-nest';
import { describePg, pgClient, resetTables } from './pg-harness';
import { EmployeesService } from '../employees/employees.service';
import { AttendanceService } from '../attendance/attendance.service';

/**
 * Giai đoạn làm việc (migration 0018) trên Postgres THẬT: khoá rồi mở khoá nhân viên KHÔNG được làm khoảng bị khoá
 * hiện lại trong chấm công cũ (Codex #63 P1). Đo qua báo cáo thật — danh sách VẮNG theo ngày (`getAbsentEmployees`,
 * dùng `employedRosterCond`) — trước và sau một chu kỳ khoá → mở khoá.
 */
const TABLES = ['audit_logs', 'employment_periods', 'attendance_records', 'employees', 'users'];

const admin = (userId: number): AuthUser =>
  ({ userId, email: `a${userId}@t`, isAdmin: true, grants: { 'users.manage': 'all', 'employees.manage': 'all' } }) as never;
const scopeAll = { ownerIds: async () => 'all' as const };

/** Ngày VN hôm nay lệch `k` ngày về trước (YYYY-MM-DD) và 12:00 trưa VN của ngày đó (xa ranh giới ngày). */
const vnDay = (k: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(Date.now() - k * 86_400_000));
const noonVn = (k: number) => new Date(`${vnDay(k)}T12:00:00+07:00`);

/** Chỉ giả `Date` (Prisma vẫn cần setTimeout / nextTick thật). */
const ALL_BUT_DATE = [
  'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
  'setTimeout', 'clearTimeout',
] as const;
async function at<T>(when: Date, fn: () => Promise<T>): Promise<T> {
  jest.useFakeTimers({ now: when, advanceTimers: true, doNotFake: [...ALL_BUT_DATE] });
  try {
    return await fn();
  } finally {
    jest.useRealTimers();
  }
}

describePg('Giai đoạn làm việc — khoá / mở khoá giữ lịch sử chấm công (Postgres thật)', () => {
  let db: PrismaService;
  let employees: EmployeesService;
  let attendance: AttendanceService;

  beforeAll(() => {
    db = pgClient();
    const audit = { write: async () => undefined };
    const rbacCache = { invalidateUsers: async () => undefined };
    const permission = { grantsFor: async () => ({ isAdmin: false, grants: {} }) };
    employees = new EmployeesService(db, audit as never, scopeAll as never, permission as never, rbacCache as never);
    attendance = new AttendanceService(db, {} as never, {} as never, scopeAll as never);
  });
  beforeEach(() => resetTables(db, TABLES));
  afterAll(() => db.$disconnect());

  async function staff(id: number, o: { status?: string; resigned_at?: Date | null; locked?: boolean } = {}) {
    await db.user.create({
      data: { id, email: `nv${id}@example.com`, password_hash: 'x', full_name: `NV ${id}`, status: o.locked ? 'locked' : 'active' },
    });
    return db.employee.create({
      data: { user_id: id, position: 'sales', status: o.status ?? 'active', resigned_at: o.resigned_at ?? null },
    });
  }
  /** user_id của những người được tính VẮNG (= có trong roster, không chấm công) vào ngày lệch `k`. */
  const rosterOn = async (k: number) => (await attendance.getAbsentEmployees(vnDay(k))).map((r) => r.user_id).sort();
  const periods = (employeeId: number) =>
    db.$queryRaw<{ started_on: string | null; ended_on: string | null }[]>`
      SELECT started_on::text, ended_on::text FROM employment_periods WHERE employee_id = ${employeeId} ORDER BY id`;

  it('khoá ngày D-10, mở khoá ngày D-5 ⇒ D-12 vẫn tính, D-8 KHÔNG tính (trước đây bị tính lại), từ D-5 tính lại', async () => {
    await staff(1); // Quản trị thao tác
    const a = await staff(10);
    const b = await staff(20); // đối chứng: luôn làm, chưa có giai đoạn nào (luật cũ)

    // Trước chu kỳ: chưa có dòng giai đoạn ⇒ luật cũ — đang làm thì mọi ngày đều tính.
    expect(await periods(a.id)).toEqual([]);
    for (const k of [12, 8, 2, 0]) expect(await rosterOn(k)).toEqual([1, 10, 20]);

    await at(noonVn(10), () => employees.lock(a.id, admin(1)));
    expect(await periods(a.id)).toEqual([{ started_on: null, ended_on: vnDay(10) }]);
    // Đang bị khoá: tính tới hết D-11, loại từ D-10.
    expect(await rosterOn(12)).toEqual([1, 10, 20]);
    expect(await rosterOn(8)).toEqual([1, 20]);
    expect(await rosterOn(0)).toEqual([1, 20]);

    await at(noonVn(5), () => employees.unlock(a.id, admin(1)));
    const e = await db.employee.findUniqueOrThrow({ where: { id: a.id } });
    expect(e.status).toBe('active');
    expect(e.resigned_at).toBeNull();
    expect(await periods(a.id)).toEqual([
      { started_on: null, ended_on: vnDay(10) },
      { started_on: vnDay(5), ended_on: null },
    ]);
    // Sau chu kỳ: khoảng bị khoá [D-10, D-5) vẫn KHÔNG tính; trước và sau đó tính.
    expect(await rosterOn(12)).toEqual([1, 10, 20]);
    expect(await rosterOn(10)).toEqual([1, 20]);
    expect(await rosterOn(8)).toEqual([1, 20]);
    expect(await rosterOn(6)).toEqual([1, 20]);
    expect(await rosterOn(5)).toEqual([1, 10, 20]);
    expect(await rosterOn(0)).toEqual([1, 10, 20]);
    // Đối chứng không đổi.
    expect(await periods(b.id)).toEqual([]);
  });

  it('nhân viên đã nghỉ theo luật cũ (resigned_at, chưa có giai đoạn) ⇒ dựng giai đoạn đúng ngày nghỉ cũ khi mở khoá', async () => {
    await staff(1);
    const c = await staff(30, { status: 'resigned', resigned_at: noonVn(7), locked: true });
    // Luật cũ: tính tới trước ngày nghỉ.
    expect(await rosterOn(9)).toEqual([1, 30]);
    expect(await rosterOn(7)).toEqual([1]);

    await at(noonVn(3), () => employees.unlock(c.id, admin(1)));
    expect(await periods(c.id)).toEqual([
      { started_on: null, ended_on: vnDay(7) },
      { started_on: vnDay(3), ended_on: null },
    ]);
    expect(await rosterOn(9)).toEqual([1, 30]);
    expect(await rosterOn(5)).toEqual([1]);
    expect(await rosterOn(3)).toEqual([1, 30]);
  });

  it('khoá lại người đang bị khoá không dời ngày nghỉ; khoá + mở khoá cùng ngày vẫn tính ngày đó', async () => {
    await staff(1);
    const a = await staff(10);
    await at(noonVn(6), () => employees.lock(a.id, admin(1)));
    await at(noonVn(2), () => employees.lock(a.id, admin(1)));
    const e = await db.employee.findUniqueOrThrow({ where: { id: a.id } });
    expect(e.resigned_at?.toISOString()).toBe(noonVn(6).toISOString());
    expect(await periods(a.id)).toEqual([{ started_on: null, ended_on: vnDay(6) }]);

    // Mở khoá hôm nay rồi khoá lại ngay hôm nay: hôm nay không tính (giai đoạn rỗng [D0, D0)), như luật cũ.
    await employees.unlock(a.id, admin(1));
    expect(await rosterOn(0)).toEqual([1, 10]);
    await employees.lock(a.id, admin(1));
    expect(await rosterOn(0)).toEqual([1]);
    expect(await rosterOn(7)).toEqual([1, 10]);
  });

  it('các đường khác: đổi status qua sửa hồ sơ (resigned ⇄ active) cũng đóng / mở giai đoạn; on_leave vẫn bị loại', async () => {
    await staff(1);
    const a = await staff(10);
    await at(noonVn(9), () => employees.update(a.id, { status: 'resigned' } as never, admin(1)));
    await at(noonVn(4), () => employees.update(a.id, { status: 'active' } as never, admin(1)));
    expect(await periods(a.id)).toEqual([
      { started_on: null, ended_on: vnDay(9) },
      { started_on: vnDay(4), ended_on: null },
    ]);
    expect(await rosterOn(6)).toEqual([1]);
    expect(await rosterOn(4)).toEqual([1, 10]);

    await employees.update(a.id, { status: 'on_leave' } as never, admin(1));
    expect(await rosterOn(0)).toEqual([1]);
    expect(await periods(a.id)).toHaveLength(2); // on_leave không chạm giai đoạn
  });

  it('hàm dùng chung (đường auth / payroll): gọi lặp lại vô hại, tối đa 1 giai đoạn mở', async () => {
    const a = await staff(10);
    await db.$transaction(async (tx) => {
      await recordEmploymentEnd(tx, a.id, noonVn(8));
      await recordEmploymentEnd(tx, a.id, noonVn(6)); // đã đóng ⇒ không dời
      await recordEmploymentStart(tx, a.id, noonVn(4));
      await recordEmploymentStart(tx, a.id, noonVn(2)); // đã mở ⇒ không mở thêm
    });
    expect(await periods(a.id)).toEqual([
      { started_on: null, ended_on: vnDay(8) },
      { started_on: vnDay(4), ended_on: null },
    ]);
    await expect(
      db.$executeRaw(Prisma.sql`INSERT INTO employment_periods (employee_id, started_on) VALUES (${a.id}, CURRENT_DATE)`),
    ).rejects.toThrow(/employment_periods_one_open_idx/);
  });
});
