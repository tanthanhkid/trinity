import { Prisma } from '@prisma/client'

/**
 * Giai đoạn làm việc (`employment_periods`) — để khoá rồi mở khoá nhân viên không xoá mất khoảng bị khoá khỏi chấm công cũ.
 *
 * Mọi đường đổi trạng thái nghỉ việc (khoá, mở khoá, đổi status, xoá vĩnh viễn — crm, auth, payroll) gọi
 * `recordEmploymentEnd` / `recordEmploymentStart` TRONG transaction và TRƯỚC khi ghi `employees.status` /
 * `resigned_at`: hàm cần trạng thái CŨ để dựng dòng đầu tiên từ luật cũ.
 *
 * Ngày = ngày theo giờ VN của `at`. `ended_on` là ngày đầu tiên KHÔNG còn làm (khớp luật cũ "loại kể từ ngày nghỉ").
 * Gọi lặp lại vô hại: đóng khi không có giai đoạn mở / mở khi đã có giai đoạn mở đều không làm gì.
 */
type Tx = Pick<Prisma.TransactionClient, '$executeRaw'>

const vnDate = (at: Date) => Prisma.sql`(${at}::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`

/**
 * Khoá dòng nhân viên (hai thao tác cùng lúc trên một người chạy lần lượt) rồi, nếu người này CHƯA có giai đoạn nào,
 * dựng giai đoạn tương đương luật cũ: đang làm ⇒ mở từ "trước đây"; đã nghỉ có `resigned_at` ⇒ đóng tại ngày nghỉ;
 * đã nghỉ mà không có ngày nghỉ (luật cũ: không tính ngày nào) ⇒ không dựng gì.
 */
async function materializeLegacy(tx: Tx, employeeId: number): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM employees WHERE id = ${employeeId} FOR UPDATE`
  await tx.$executeRaw`
    INSERT INTO employment_periods (employee_id, started_on, ended_on)
    SELECT e.id, NULL,
           CASE WHEN e.status = 'resigned' THEN (e.resigned_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date END
    FROM employees e
    WHERE e.id = ${employeeId}
      AND NOT (e.status = 'resigned' AND e.resigned_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM employment_periods p WHERE p.employee_id = e.id)`
}

/** Nghỉ việc / bị khoá từ ngày của `at`: đóng giai đoạn đang mở. */
export async function recordEmploymentEnd(tx: Tx, employeeId: number, at: Date = new Date()): Promise<void> {
  await materializeLegacy(tx, employeeId)
  await tx.$executeRaw`
    UPDATE employment_periods SET ended_on = ${vnDate(at)}
    WHERE employee_id = ${employeeId} AND ended_on IS NULL`
}

/** Đi làm lại / được mở khoá từ ngày của `at`: mở giai đoạn mới (nếu chưa có giai đoạn đang mở). */
export async function recordEmploymentStart(tx: Tx, employeeId: number, at: Date = new Date()): Promise<void> {
  await materializeLegacy(tx, employeeId)
  await tx.$executeRaw`
    INSERT INTO employment_periods (employee_id, started_on)
    SELECT ${employeeId}, ${vnDate(at)}
    WHERE NOT EXISTS (SELECT 1 FROM employment_periods p WHERE p.employee_id = ${employeeId} AND p.ended_on IS NULL)`
}

/**
 * Ghi nhận việc đổi `employees.status` từ `from` sang `to`: vào `resigned` ⇒ đóng giai đoạn; rời `resigned` ⇒ mở
 * giai đoạn mới; các đổi khác (active ⇄ probation …) không chạm giai đoạn.
 */
export async function recordEmploymentStatusChange(
  tx: Tx,
  employeeId: number,
  from: string | null | undefined,
  to: string | null | undefined,
  at: Date = new Date(),
): Promise<void> {
  if (to === 'resigned' && from !== 'resigned') await recordEmploymentEnd(tx, employeeId, at)
  else if (from === 'resigned' && to != null && to !== 'resigned') await recordEmploymentStart(tx, employeeId, at)
}

/**
 * Điều kiện SQL "nhân viên `e` đang làm vào ngày `ref`" (alias bảng employees phải là `e`). `ref` là cột cố định
 * (`Prisma.raw('ar.work_date')`) hoặc tham số đã parameterized — KHÔNG ghép giá trị người dùng bằng `Prisma.raw`.
 * - Đã có giai đoạn: status `active`/`resigned` VÀ có giai đoạn phủ `ref` (các status khác — on_leave, probation… —
 *   vẫn bị loại như luật cũ).
 * - Chưa có giai đoạn: luật cũ — `active`, hoặc `resigned` mà `ref` còn trước ngày nghỉ (giờ VN).
 */
export function employedOnSql(ref: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(CASE WHEN EXISTS (SELECT 1 FROM employment_periods ep0 WHERE ep0.employee_id = e.id)
    THEN e.status IN ('active', 'resigned') AND EXISTS (
      SELECT 1 FROM employment_periods ep WHERE ep.employee_id = e.id
        AND (ep.started_on IS NULL OR ep.started_on <= ${ref})
        AND (ep.ended_on IS NULL OR ${ref} < ep.ended_on))
    ELSE (e.status = 'active' OR (e.status = 'resigned' AND e.resigned_at IS NOT NULL AND (e.resigned_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date > ${ref}))
  END)`
}
