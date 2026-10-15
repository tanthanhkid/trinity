import { Injectable } from '@nestjs/common';
import type { GoogleSheetSync } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import { PermissionService, type AuthUser } from '@trinity/rbac-nest';
import { can } from '@trinity/rbac';
import { CustomRecordsService } from '../custom-objects/custom-records.service';
import { dedupeValue, type MappedRow } from './sheet-mapping';
import { addError, type RunStats } from './sync-types';

/**
 * Nhập bản ghi bảng tuỳ biến từ Sheet. Ghi qua `CustomRecordsService` với quyền của NGƯỜI THIẾT LẬP cấu hình
 * (không đường tắt): kiểm kiểu/bắt buộc/duy nhất/phạm vi y như người đó tự nhập tay.
 */
@Injectable()
export class SheetImportCustom {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly records: CustomRecordsService,
  ) {}

  private async actor(userId: number): Promise<AuthUser> {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, status: true, deleted_at: true } });
    if (!u || u.status !== 'active' || u.deleted_at) throw new Error('Người thiết lập cấu hình không còn hoạt động');
    const { grants, isAdmin } = await this.permissions.grantsFor(userId);
    const user: AuthUser = { userId, email: u.email, isAdmin, grants };
    if (!isAdmin && !can(grants, 'custom_records.manage')) throw new Error('Người thiết lập không còn quyền thêm/sửa dữ liệu tuỳ biến');
    return user;
  }

  async run(sync: GoogleSheetSync, rows: MappedRow[], stats: RunStats): Promise<void> {
    const key = sync.target_object_key as string;
    const user = await this.actor(sync.actor_user_id);
    const obj = await this.prisma.customObject.findFirst({ where: { key, deleted_at: null }, select: { id: true } });
    if (!obj) throw new Error(`Bảng tuỳ biến "${key}" không còn tồn tại`);
    for (const r of rows) {
      try {
        const data: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r.fields)) if (v !== '') data[k] = v;
        const dv = dedupeValue(sync.dedupe_key, r.fields);
        if (dv === null) { stats.invalid++; continue; }
        const existing = await this.findByKey(obj.id, sync.dedupe_key, r.fields[sync.dedupe_key]);
        if (existing) {
          await this.records.update(user, key, existing, { data });
          stats.updated++;
        } else {
          await this.records.create(user, key, { data });
          stats.created++;
        }
      } catch (e) {
        addError(stats, r.row, errorText(e));
      }
    }
  }

  private async findByKey(objectId: number, field: string, value: string): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<{ id: number }[]>`
      SELECT id FROM custom_records WHERE object_id = ${objectId} AND deleted_at IS NULL
        AND lower(data->>${field}) = lower(${value.trim()}) ORDER BY id ASC LIMIT 1`;
    return rows[0]?.id ?? null;
  }
}

function errorText(e: unknown): string {
  const r = (e as { getResponse?: () => unknown })?.getResponse?.();
  const errs = r && typeof r === 'object' ? (r as { errors?: Record<string, string> }).errors : undefined;
  if (errs) return Object.values(errs).slice(0, 3).join('; ');
  return (e as Error)?.message ?? 'lỗi không rõ';
}
