import { PrismaService } from '@trinity/prisma';

/**
 * Test chạy trên Postgres THẬT (`*.pg.spec.ts`): kiểm các câu SQL raw / transaction mà mock không bắt được
 * (vd `left(varchar, bigint)` từng làm webhook SePay trả 500). Không đặt TEST_DATABASE_URL ⇒ cả file tự bỏ qua.
 * CI: job "SQL on Postgres" dựng Postgres 16 + `prisma migrate deploy` rồi chạy `jest --testRegex '\.pg\.spec\.ts$'`.
 */
export const PG_URL = process.env.TEST_DATABASE_URL ?? '';
export const describePg = PG_URL ? describe : describe.skip;

export function pgClient(): PrismaService {
  process.env.DATABASE_URL = PG_URL;
  return new PrismaService();
}

/** Xoá dữ liệu các bảng test dùng (DB riêng cho test, không bao giờ trỏ vào DB thật). */
export async function resetTables(db: PrismaService, tables: string[]): Promise<void> {
  if (!isLocalDbUrl(PG_URL)) throw new Error('TEST_DATABASE_URL phải trỏ vào Postgres cục bộ/CI');
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

/** Chỉ cho xoá dữ liệu khi HOST (đã tách bằng URL, không phải regex trên cả chuỗi — tên người dùng `postgres` không được tính) là máy cục bộ/CI. */
export function isLocalDbUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return ['postgresql:', 'postgres:'].includes(u.protocol) && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}
