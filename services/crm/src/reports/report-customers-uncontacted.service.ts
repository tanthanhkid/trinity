import { Injectable } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import { ScopeService } from '@trinity/rbac-nest';
// ScopeService PHẢI import THẬT (không type-only) — constructor DI của NestJS
// cần class reference runtime cho `emitDecoratorMetadata`; import type ở đây
// làm Nest resolve param type ra `Object` và ném lỗi không inject được.
import type { AuthUser } from '@trinity/rbac-nest';
import { makePhoneMasker } from '@trinity/rbac-nest';
import { buildContactScopeWhere } from './helpers/report-scope.helper';
import { QueryReportUncontactedDto } from './dto/query-report-uncontacted.dto';

const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface UncontactedContactRow {
  id: number;
  full_name: string | null;
  phone: string;
  assigned_to: number | null;
  assignee_name: string | null;
  created_at: Date;
}

export interface UncontactedResult {
  rows: UncontactedContactRow[];
  next_cursor: number | null;
  days: number;
}

/**
 * "Khách chưa được chăm sóc quá N ngày" — contact KHÔNG có `Activity` nào
 * (mọi loại action) trong N ngày gần nhất.
 * Dùng Prisma relation filter `activities: { none: ... } }`.
 *
 * Phạm vi dữ liệu = quyền `reports.customers`; SĐT che theo quyền
 * `contacts.phone_full`.
 */
@Injectable()
export class ReportCustomersUncontactedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  async getUncontacted(
    user: AuthUser,
    dto: QueryReportUncontactedDto,
  ): Promise<UncontactedResult> {
    const days = dto.days ?? DEFAULT_DAYS;
    const limit = Math.min(dto.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [owner, phoneOwner] = await Promise.all([
      this.scope.ownerIds(user, 'reports.customers'),
      this.scope.ownerIds(user, 'contacts.phone_full'),
    ]);
    const baseWhere = buildContactScopeWhere(owner ?? []);
    const where = {
      AND: [baseWhere, { activities: { none: { created_at: { gte: cutoff } } } }],
    };

    const rows = await this.prisma.contact.findMany({
      where,
      take: limit,
      ...(dto.cursor ? { skip: 1, cursor: { id: dto.cursor } } : {}),
      orderBy: { id: 'desc' },
      select: {
        id: true,
        full_name: true,
        phone: true,
        assigned_to: true,
        created_by_id: true,
        created_at: true,
        assigned_user: { select: { full_name: true } },
      },
    });

    const maskFn = makePhoneMasker(phoneOwner ?? []);

    return {
      rows: rows.map((r) => ({
        id: r.id,
        full_name: r.full_name,
        // `contacts.phone` NOT NULL trong schema — fallback `?? ''` chỉ ép
        // kiểu cho chữ ký dùng chung `makePhoneMasker` (`string | null`).
        phone: maskFn([r.assigned_to, r.created_by_id], r.phone) ?? '',
        assigned_to: r.assigned_to,
        assignee_name: r.assigned_user?.full_name ?? null,
        created_at: r.created_at,
      })),
      next_cursor: rows.length === limit ? rows[rows.length - 1].id : null,
      days,
    };
  }
}
