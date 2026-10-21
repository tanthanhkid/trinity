import { PrismaService } from '@trinity/prisma';

/**
 * Test chạy trên Postgres THẬT (`*.pg.spec.ts`) cho services/commerce — cùng cách với services/crm/src/__pg__/pg-harness.ts.
 * Không đặt TEST_DATABASE_URL ⇒ cả file tự bỏ qua. CI: job "SQL on Postgres" (migrate deploy rồi chạy jest).
 */
export const PG_URL = process.env.TEST_DATABASE_URL ?? '';
export const describePg = PG_URL ? describe : describe.skip;

export function pgClient(): PrismaService {
  process.env.DATABASE_URL = PG_URL;
  return new PrismaService();
}

/** Xoá dữ liệu các bảng test dùng — chỉ khi DB là máy cục bộ / CI. */
export async function resetTables(db: PrismaService, tables: string[]): Promise<void> {
  if (!isLocalDbUrl(PG_URL)) throw new Error('TEST_DATABASE_URL phải trỏ vào Postgres cục bộ/CI');
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

export function isLocalDbUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return ['postgresql:', 'postgres:'].includes(u.protocol) && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}
