import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type CustomRecord } from '@prisma/client';
import { PrismaService, publishIntegrationEvent } from '@trinity/prisma';
import { can } from '@trinity/rbac';
import { assertInScope, ScopeService, type AuthUser } from '@trinity/rbac-nest';
import { loadVisibleObject, type ObjectDef } from './custom-object-access';
import type { RecordData } from './field-types';
import { objectRef, recordSnapshot, titleOf } from './record-events';
import { RecordPresenter, type RecordView } from './record-presenter.service';
import { RecordValidator } from './record-validator.service';
import type { CustomRecordBodyDto } from './dto/custom-record.dto';
import { linkingFields, RecordLinksService } from './refs/record-links.service';

const LOCK_NS = 7373;
export interface MinimalRecord { id: number }
const asData = (v: unknown): RecordData => (v && typeof v === 'object' && !Array.isArray(v) ? (v as RecordData) : {});

/** Ghi bản ghi tuỳ biến (tạo / sửa / xoá mềm) + outbox sự kiện CÙNG transaction. Phạm vi theo `custom_records.manage|delete`. */
@Injectable()
export class CustomRecordsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly validator: RecordValidator,
    private readonly presenter: RecordPresenter,
    private readonly links: RecordLinksService,
  ) {}

  async create(user: AuthUser, key: string, dto: CustomRecordBodyDto): Promise<RecordView | MinimalRecord> {
    // Mọi nơi gọi (controller, MCP, import Sheet, chương trình con) đều đi qua đây ⇒ kiểm quyền ghi ở tầng service.
    if (!can(user.grants, 'custom_records.manage')) throw new ForbiddenException('Không đủ quyền tạo bản ghi tuỳ biến');
    const def = await loadVisibleObject(this.prisma, user, key);
    const ownerId = await this.resolveOwner(user, dto.owner_id);
    const v = await this.validator.validate(def, user, dto.data, null);
    const targets = await this.links.targetsFor(def, user, v.data);
    const row = await this.prisma.$transaction(async (tx) => {
      await this.lockIfUnique(tx, def);
      await this.validator.assertUnique(tx, def, v.data, v.changed, null);
      const r = await tx.customRecord.create({
        data: { object_id: def.obj.id, data: v.data as Prisma.InputJsonValue, title: titleOf(def, v.data), owner_id: ownerId, created_by: user.userId },
      });
      await publishIntegrationEvent(tx, 'custom_record.created', { object: objectRef(def), record: recordSnapshot(def, r) }, { resourceId: r.id, actorUserId: user.userId });
      await this.links.sync(tx, { type: 'record', id: r.id }, targets, user.userId);
      return r;
    });
    return this.respond(def, user, row);
  }

  async update(user: AuthUser, key: string, id: number, dto: Partial<CustomRecordBodyDto>): Promise<RecordView | MinimalRecord> {
    const def = await loadVisibleObject(this.prisma, user, key);
    const pre = await this.loadInScope(def, id, user, 'custom_records.manage');
    const ownerWanted = dto.owner_id != null && dto.owner_id !== pre.owner_id ? await this.resolveOwner(user, dto.owner_id) : null;
    const row = await this.prisma.$transaction(async (tx) => {
      // Khoá DÒNG rồi mới đọc-gộp-kiểm: 2 PATCH song song (khác trường) không ghi đè nhau (lost update).
      const locked = await tx.$queryRaw<{ id: number }[]>(Prisma.sql`SELECT id FROM custom_records WHERE id = ${id} AND object_id = ${def.obj.id} AND deleted_at IS NULL FOR UPDATE`);
      if (locked.length === 0) throw new NotFoundException('Không tìm thấy bản ghi');
      const cur = await tx.customRecord.findUniqueOrThrow({ where: { id } });
      const ownerId = ownerWanted ?? cur.owner_id;
      const v = await this.validator.validate(def, user, dto.data ?? {}, asData(cur.data));
      await this.lockIfUnique(tx, def);
      await this.validator.assertUnique(tx, def, v.data, v.changed, id);
      const r = await tx.customRecord.update({
        where: { id },
        data: { data: v.data as Prisma.InputJsonValue, title: titleOf(def, v.data), owner_id: ownerId },
      });
      const changed = ownerId !== cur.owner_id ? [...v.changed, 'owner_id'] : v.changed;
      const linkKeys = linkingFields(def).map((f) => f.key).filter((k) => v.changed.includes(k));
      if (linkKeys.length) await this.links.sync(tx, { type: 'record', id }, await this.links.targetsFor(def, user, v.data, linkKeys), user.userId);
      await publishIntegrationEvent(tx, 'custom_record.updated', { object: objectRef(def), record: recordSnapshot(def, r), changed_fields: changed }, { resourceId: id, actorUserId: user.userId });
      return r;
    }, { timeout: 15_000 });
    return this.respond(def, user, row);
  }

  async remove(user: AuthUser, key: string, id: number) {
    const def = await loadVisibleObject(this.prisma, user, key);
    const cur = await this.loadInScope(def, id, user, 'custom_records.delete');
    await this.prisma.$transaction(async (tx) => {
      await tx.customRecord.update({ where: { id }, data: { deleted_at: new Date() } });
      await publishIntegrationEvent(tx, 'custom_record.deleted', { object: objectRef(def), record: recordSnapshot(def, cur) }, { resourceId: id, actorUserId: user.userId });
    });
    return { ok: true };
  }

  /**
   * Phản hồi sau khi ghi: bản ghi đầy đủ CHỈ khi nó nằm trong phạm vi XEM của người ghi (phạm vi sửa có thể rộng hơn
   * phạm vi) — ngoài ra chỉ trả `{id}` để không biến PATCH thành đường ĐỌC dữ liệu ngoài phạm vi.
   */
  private async respond(def: ObjectDef, user: AuthUser, row: CustomRecord): Promise<RecordView | MinimalRecord> {
    const view = await this.scope.ownerIds(user, 'custom_records.view');
    const visible = view === 'all' || (view !== null && [row.owner_id, row.created_by].some((o) => o != null && view.includes(o)));
    return visible ? (await this.presenter.present(def, user, [row]))[0] : { id: row.id };
  }

  private async loadInScope(def: ObjectDef, id: number, user: AuthUser, perm: 'custom_records.manage' | 'custom_records.delete') {
    const row = await this.prisma.customRecord.findFirst({ where: { id, object_id: def.obj.id, deleted_at: null } });
    if (!row) throw new NotFoundException('Không tìm thấy bản ghi');
    await assertInScope(this.scope, user, perm, [row.owner_id, row.created_by]);
    return row;
  }

  /** Người phụ trách: mặc định = người ghi; người khác phải active và nằm trong phạm vi quyền sửa của người ghi. */
  private async resolveOwner(user: AuthUser, requested: number | null | undefined): Promise<number> {
    if (requested == null || requested === user.userId) return user.userId;
    const owners = await this.scope.ownerIds(user, 'custom_records.manage');
    if (owners === null || (owners !== 'all' && !owners.includes(requested))) {
      throw new BadRequestException({ statusCode: 400, message: 'Dữ liệu không hợp lệ', errors: { owner_id: 'Không giao được cho người này (ngoài phạm vi của bạn)' } });
    }
    const exists = await this.prisma.user.count({ where: { id: requested, status: 'active', deleted_at: null } });
    if (exists === 0) throw new BadRequestException({ statusCode: 400, message: 'Dữ liệu không hợp lệ', errors: { owner_id: 'Người phụ trách không tồn tại hoặc đã khoá' } });
    return requested;
  }

  /** Tuần tự hoá ghi của thực thể có trường “duy nhất” (2 yêu cầu song song không cùng lọt qua kiểm trùng). */
  private async lockIfUnique(tx: Prisma.TransactionClient, def: ObjectDef): Promise<void> {
    if (def.fields.some((f) => f.is_unique)) await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${LOCK_NS}::int, ${def.obj.id}::int)`);
  }
}
