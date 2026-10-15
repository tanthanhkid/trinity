import { Injectable } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { PermissionService, type AuthUser } from '@trinity/rbac-nest';
import { CustomRecordsListService } from '../custom-objects/custom-records-list.service';
import { CustomRecordsService } from '../custom-objects/custom-records.service';
import type { ListCustomRecordsQueryDto } from '../custom-objects/dto/custom-record.dto';
import { restrictForAi } from '../integrations/mcp/mcp-auth.service';
import type { DataActor, DataPort } from './runner/gateway';

const USER_TTL_MS = 60_000;

/**
 * Cổng dữ liệu THẬT của chương trình con: đi qua đúng service + RBAC của bản ghi tuỳ biến, dưới danh nghĩa NGƯỜI ĐÃ DUYỆT phiên bản đang chạy
 * (bị gỡ `*.phone_full` và cờ admin như AI). Phạm vi bảng do gateway kiểm trước (manifest); ở đây thêm phạm vi theo quyền của người duyệt.
 */
@Injectable()
export class ExtensionsDataPort implements DataPort {
  private readonly users = new Map<number, { at: number; user: AuthUser }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly records: CustomRecordsService,
    private readonly lists: CustomRecordsListService,
  ) {}

  async create(actor: DataActor, table: string, rows: Record<string, unknown>[]): Promise<{ created: number }> {
    const user = await this.actorUser(actor);
    let created = 0;
    for (const data of rows) {
      await this.records.create(user, table, { data });
      created++;
    }
    return { created };
  }

  async list(actor: DataActor, table: string, q: { limit: number; cursor?: string }) {
    const user = await this.actorUser(actor);
    const res = await this.lists.list(user, table, { limit: q.limit, cursor: q.cursor } as ListCustomRecordsQueryDto);
    return { items: res.items as unknown[], next_cursor: res.next_cursor ?? null };
  }

  private async actorUser(a: DataActor): Promise<AuthUser> {
    const userId = a.asUserId ?? (await this.approverOf(a.extId));
    const hit = this.users.get(userId);
    if (hit && Date.now() - hit.at < USER_TTL_MS) return hit.user;
    // Người duyệt đã bị khoá/xoá thì chương trình con không còn chạy dưới quyền họ.
    const approver = await this.prisma.user.findUnique({ where: { id: userId }, select: { status: true, deleted_at: true } });
    if (!approver || approver.status !== 'active' || approver.deleted_at !== null) {
      throw new Error('Người duyệt chương trình con không còn hoạt động');
    }
    const { grants, isAdmin } = await this.permissions.grantsFor(userId);
    const user = restrictForAi({ userId, email: '', isAdmin, grants });
    this.users.set(userId, { at: Date.now(), user });
    return user;
  }

  private async approverOf(extId: number): Promise<number> {
    const ext = await this.prisma.extension.findUnique({ where: { id: extId }, select: { active_version_id: true } });
    const v = ext?.active_version_id ? await this.prisma.extensionVersion.findUnique({ where: { id: ext.active_version_id }, select: { reviewed_by: true, review_status: true } }) : null;
    if (!v || v.review_status !== 'approved' || v.reviewed_by === null) throw new Error('Chương trình con chưa có phiên bản được duyệt đang chạy');
    return v.reviewed_by;
  }
}
