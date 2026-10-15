import { Injectable } from '@nestjs/common';
import type { GoogleSheetSync, Prisma } from '@prisma/client';
import { PrismaService, publishIntegrationEvent, snapshotContact, CONTACT_EVENT_SELECT } from '@trinity/prisma';
import { assertInScope, PermissionService, ScopeService, type AuthUser } from '@trinity/rbac-nest';
import { PublicApiService } from '../public-api/public-api.service';
import { normalizeEmail, normalizePhone, type MappedRow } from './sheet-mapping';
import { addError, type RunStats } from './sync-types';

export const IMPORT_ORIGIN = 'google_sheet_import';
const UPDATABLE = ['full_name', 'email', 'phone_2', 'zalo_account', 'job_title', 'company_name', 'current_address'] as const;
type Updatable = (typeof UPDATABLE)[number];

const phoneVariants = (local: string): string[] => [local, `84${local.slice(1)}`, `+84${local.slice(1)}`];

/** Giá trị từng trường sau chuẩn hoá; chuỗi rỗng = "không đổi" (nhập KHÔNG bao giờ xoá dữ liệu CRM bằng ô trống). */
export function contactPatch(fields: Record<string, string>): Partial<Record<Updatable | 'phone', string>> {
  const out: Partial<Record<Updatable | 'phone', string>> = {};
  const phone = normalizePhone(fields.phone);
  if (phone) out.phone = phone;
  for (const k of UPDATABLE) {
    const raw = (fields[k] ?? '').trim();
    if (raw === '') continue;
    if (k === 'email') { const e = normalizeEmail(raw); if (e) out.email = e; continue; }
    if (k === 'phone_2') { const p = normalizePhone(raw); if (p) out.phone_2 = p; continue; }
    out[k] = raw.slice(0, 255);
  }
  return out;
}

/** Nhập khách từ Sheet: khử trùng theo SĐT/email (khoá cấu hình), tạo mới hoặc cập nhật phần ô có dữ liệu. */
@Injectable()
export class SheetImportContacts {
  constructor(
    private readonly prisma: PrismaService,
    private readonly publicApi: PublicApiService,
    private readonly permissions: PermissionService,
    private readonly scope: ScopeService,
  ) {}

  async run(sync: GoogleSheetSync, rows: MappedRow[], stats: RunStats): Promise<void> {
    const owner = await this.prisma.user.findUnique({ where: { id: sync.actor_user_id }, select: { id: true, email: true, team_id: true, status: true, deleted_at: true } });
    if (!owner || owner.status !== 'active' || owner.deleted_at) throw new Error('Người nhận khách của cấu hình không còn hoạt động');
    // Cập nhật khách trùng đi qua phạm vi `contacts.update` của người nhận khách, y như sửa tay.
    const { grants, isAdmin } = await this.permissions.grantsFor(owner.id);
    const actor: AuthUser = { userId: owner.id, email: owner.email, isAdmin, grants };
    for (const r of rows) {
      try {
        await this.one(sync, r, owner, stats, actor);
      } catch (e) {
        addError(stats, r.row, (e as Error).message);
      }
    }
  }

  private async one(sync: GoogleSheetSync, r: MappedRow, owner: { id: number; team_id: number | null }, stats: RunStats, actor: AuthUser): Promise<void> {
    const patch = contactPatch(r.fields);
    const key = sync.dedupe_key === 'email' ? 'email' : 'phone';
    if (!patch[key]) { stats.invalid++; return; }
    if (!patch.phone) { stats.invalid++; return; } // khách luôn cần SĐT
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${patch.phone as string}))`;
      const where: Prisma.ContactWhereInput = key === 'email' ? { email: { equals: patch.email, mode: 'insensitive' } } : { phone: { in: phoneVariants(patch.phone as string) } };
      const dup = await tx.contact.findFirst({ where: { ...where, deleted_at: null }, orderBy: { id: 'asc' }, select: { id: true, phone: true, assigned_to: true, created_by_id: true, ...Object.fromEntries(UPDATABLE.map((k) => [k, true])) } });
      if (!dup) {
        await this.publicApi.createContactInTx(
          tx,
          { phone: patch.phone as string, full_name: patch.full_name, email: patch.email, phone_2: patch.phone_2, zalo_account: patch.zalo_account, job_title: patch.job_title, company_name: patch.company_name, current_address: patch.current_address, source_id: sync.contact_source_id },
          owner,
          IMPORT_ORIGIN,
        );
        stats.created++;
        return;
      }
      const cur = dup as unknown as Record<string, string | null>;
      const changed = UPDATABLE.filter((k) => patch[k] !== undefined && patch[k] !== cur[k]);
      if (changed.length === 0) { stats.unchanged++; return; }
      const data = Object.fromEntries(changed.map((k) => [k, patch[k]]));
      await assertInScope(this.scope, actor, 'contacts.update', [dup.assigned_to, dup.created_by_id]).catch(() => {
        throw new Error('Khách trùng thuộc phạm vi người nhận khách không được sửa');
      });
      const updated = await tx.contact.update({ where: { id: dup.id }, data, select: CONTACT_EVENT_SELECT });
      await publishIntegrationEvent(tx, 'contact.updated', { contact: snapshotContact(updated), changed_fields: changed }, { resourceId: dup.id, actorUserId: owner.id });
      stats.updated++;
    });
  }
}
