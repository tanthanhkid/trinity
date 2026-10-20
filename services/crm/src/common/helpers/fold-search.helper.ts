import { Prisma } from '@prisma/client';
import { foldVi, SQL_FOLD_FROM, SQL_FOLD_TO } from '../../custom-objects/refs/fold-vi';
import { escapeLike } from '../../custom-objects/record-query';

/**
 * Ô tìm DÙNG CHUNG mọi bảng: không phân biệt hoa/thường, bỏ dấu tiếng Việt, khớp chuỗi con
 * ("minh" ra "Minh", "Bé Minh", "Mính"). Gập bằng `translate(lower())` — PG thuần, không cần extension `unaccent`.
 */

/** Biểu thức SQL đã gập (chữ thường, bỏ dấu) — so với `foldContains(q)`. */
export function foldSql(expr: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`translate(lower(${expr}), ${SQL_FOLD_FROM}, ${SQL_FOLD_TO})`;
}

/** Mẫu LIKE "chứa" của từ khoá đã gập: " Mính " → "%minh%". */
export function foldContains(q: string): string {
  return `%${escapeLike(foldVi(q.trim()))}%`;
}

/** `expr` chứa `q` (không phân biệt hoa/thường/dấu). */
export function foldMatchSql(expr: Prisma.Sql, q: string): Prisma.Sql {
  return Prisma.sql`${foldSql(expr)} LIKE ${foldContains(q)} ESCAPE '\\'`;
}

/** Trần số id trả về — đủ cho CRM cỡ SME; từ khoá quá rộng thì kết quả vẫn đúng phần `contains` gốc. */
export const FOLD_ID_CAP = 5000;

const FOLD_TABLES = {
  contacts: { col: 'full_name', live: 'deleted_at IS NULL' },
  deals: { col: 'title', live: 'TRUE' },
} as const;

/**
 * id dòng của bảng lõi có tên chứa `q` (bỏ dấu) — ghép vào where Prisma bằng `{ id: { in } }` cạnh
 * điều kiện phạm vi. KHÔNG tự lọc phạm vi: nơi gọi luôn AND với `scopeWhere`.
 */
export async function foldedIds(
  prisma: { $queryRaw: <T>(q: Prisma.Sql) => Prisma.PrismaPromise<T> },
  table: keyof typeof FOLD_TABLES,
  q: string,
): Promise<number[]> {
  const t = FOLD_TABLES[table];
  const rows = await prisma.$queryRaw<{ id: number }[]>(Prisma.sql`
    SELECT id FROM ${Prisma.raw(table)} WHERE ${Prisma.raw(t.live)} AND ${foldMatchSql(Prisma.raw(t.col), q)}
    ORDER BY id DESC LIMIT ${FOLD_ID_CAP}`);
  return rows.map((r) => r.id);
}
