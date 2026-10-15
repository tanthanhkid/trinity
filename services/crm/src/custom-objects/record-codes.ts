import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '@trinity/prisma';

/**
 * Mã chung của bản ghi (HS001, KH012…). DB cấp mã lúc INSERT bằng trigger (migration `0000_init`) — file này
 * chỉ có định dạng + đổi tiền tố. Mã = tiền tố (2–4 chữ in hoa) + số tăng dần đệm 3 chữ số; không bao giờ dùng lại số đã cấp.
 */

/** Tiền tố của bảng lõi — bảng tuỳ biến không được lấy (khớp `trinity_reserved_code_prefixes()` trong DB). */
export const CORE_CODE_PREFIXES = { contact: 'KH', deal: 'DL', task: 'CV' } as const;
export const RESERVED_CODE_PREFIXES: readonly string[] = Object.values(CORE_CODE_PREFIXES);

export const PREFIX_RE = /^[A-Z]{2,4}$/;
/** Mã đầy đủ: tiền tố + số (không phân biệt hoa thường khi người dùng gõ). */
export const CODE_RE = /^([A-Za-z]{2,4})(\d{1,9})$/;

export interface ParsedCode { prefix: string; seq: number; code: string }

/** "hs1" / "HS001" → {prefix:'HS', seq:1, code:'HS001'}; sai dạng → null. */
export function parseCode(raw: string): ParsedCode | null {
  const m = CODE_RE.exec(raw.trim());
  if (!m) return null;
  const seq = Number(m[2]);
  if (!Number.isSafeInteger(seq) || seq <= 0) return null;
  const prefix = m[1].toUpperCase();
  return { prefix, seq, code: formatCode(prefix, seq) };
}

/** Khớp `trinity_code_num()` của DB: 1 → 001, 1000 → 1000. */
export function formatCode(prefix: string, seq: number): string {
  return `${prefix}${seq < 1000 ? String(seq).padStart(3, '0') : String(seq)}`;
}

/** Chuẩn hoá + kiểm dạng tiền tố do người dùng/AI đặt. */
export function normalizePrefix(raw: string): string {
  // `code_prefix: null` lọt qua @IsOptional của DTO — trả 400 thay vì TypeError/500.
  if (typeof raw !== 'string') throw new BadRequestException('Tiền tố mã không được để trống');
  const p = raw.trim().toUpperCase();
  if (!PREFIX_RE.test(p)) throw new BadRequestException('Tiền tố mã phải gồm 2–4 chữ cái in hoa không dấu (vd HS, BN, KHO)');
  if (RESERVED_CODE_PREFIXES.includes(p)) throw new BadRequestException(`Tiền tố “${p}” dành cho bảng lõi (KH = khách hàng, DL = deal, CV = công việc)`);
  return p;
}

type Db = Pick<PrismaService, '$queryRaw'> | Prisma.TransactionClient;

/** Tiền tố đã có chủ (bảng lõi, tiền tố hiện tại hoặc CŨ của bảng khác). */
export async function prefixTaken(db: Db, prefix: string, selfId: number | null): Promise<boolean> {
  const r = await db.$queryRaw<{ taken: boolean }[]>(Prisma.sql`SELECT trinity_code_prefix_taken(${prefix}, ${selfId}::int) AS taken`);
  return r[0]?.taken === true;
}

/** Tiền tố DB sẽ tự sinh cho tên này (để AI/người duyệt thấy trước, chưa giữ chỗ). */
export async function suggestPrefix(db: Db, label: string): Promise<string> {
  const r = await db.$queryRaw<{ p: string }[]>(Prisma.sql`SELECT trinity_pick_code_prefix(${label}, NULL::int) AS p`);
  return r[0]?.p ?? '';
}

/**
 * Đổi tiền tố của một bảng: tiền tố cũ vào `code_prefix_aliases` (mã cũ vẫn tra được, không bảng khác lấy lại), mã của
 * mọi bản ghi (kể cả đã xoá) đổi theo, PHẦN SỐ giữ nguyên. Một giao dịch + khoá tư vấn chung với trigger sinh tiền tố.
 */
export async function renamePrefix(prisma: PrismaService, objectId: number, raw: string): Promise<string> {
  const next = normalizePrefix(raw);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(7374)`);
    const cur = await tx.customObject.findUniqueOrThrow({ where: { id: objectId }, select: { code_prefix: true, code_prefix_aliases: true } });
    if (cur.code_prefix === next) return next;
    if (await prefixTaken(tx, next, objectId)) throw new ConflictException(`Tiền tố “${next}” đã được bảng khác dùng (hoặc từng dùng)`);
    const aliases = [...new Set([...cur.code_prefix_aliases, ...(cur.code_prefix ? [cur.code_prefix] : [])])].filter((p) => p !== next).slice(-20);
    await tx.customObject.update({ where: { id: objectId }, data: { code_prefix: next, code_prefix_aliases: aliases } });
    await tx.$executeRaw(Prisma.sql`UPDATE custom_records SET code = ${next} || trinity_code_num(code_seq) WHERE object_id = ${objectId} AND code_seq IS NOT NULL`);
    return next;
  });
}
