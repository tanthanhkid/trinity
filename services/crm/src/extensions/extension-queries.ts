import { NotFoundException } from '@nestjs/common';
import type { Extension, ExtensionVersion, Prisma } from '@prisma/client';
import type { PrismaService } from '@trinity/prisma';

export type Db = Prisma.TransactionClient | PrismaService;
export type ExtRef = number | string;

/** Tra chương trình con còn sống theo id (số) hoặc mã (chữ). */
export async function findExt(db: Db, ref: ExtRef): Promise<Extension> {
  const where = typeof ref === 'number' ? { id: ref, deleted_at: null } : { key: ref, deleted_at: null };
  const e = await db.extension.findFirst({ where });
  if (!e) throw new NotFoundException('Không tìm thấy chương trình con');
  return e;
}

/** Khoá DÒNG chương trình con (tuần tự hoá cấp số phiên bản / duyệt song song) rồi đọc lại. */
export async function lockExt(tx: Prisma.TransactionClient, ref: ExtRef): Promise<Extension> {
  const e = await findExt(tx, ref);
  await tx.$queryRaw`SELECT id FROM extensions WHERE id = ${e.id} FOR UPDATE`;
  return tx.extension.findUniqueOrThrow({ where: { id: e.id } });
}

export async function versionOf(db: Db, extId: number, version: number): Promise<ExtensionVersion> {
  const v = await db.extensionVersion.findUnique({ where: { extension_id_version: { extension_id: extId, version } } });
  if (!v) throw new NotFoundException(`Không có phiên bản ${version}`);
  return v;
}

/** Số hiệu phiên bản đang chạy (null nếu chưa deploy). */
export async function activeNo(db: Db, e: Extension): Promise<number | null> {
  if (e.active_version_id === null) return null;
  return (await db.extensionVersion.findUnique({ where: { id: e.active_version_id }, select: { version: true } }))?.version ?? null;
}
