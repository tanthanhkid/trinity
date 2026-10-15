import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '@trinity/prisma';
import { PublicApiService } from '../public-api/public-api.service';
import { parseLeadFields, type ParsedLead } from './facebook-lead-fields';
import { FacebookPagesService } from './facebook-pages.service';
import { GraphApiError, GraphClient } from './graph-client';

export interface LeadgenChange {
  leadgen_id?: string;
  page_id?: string;
  form_id?: string;
}

export type LeadResult = 'created' | 'duplicate' | 'no_contact_info' | 'owner_inactive' | 'skipped' | 'already_processed';

/** Số điện thoại 0xxxxxxxxx → các dạng đã lưu (cùng cách khử trùng của webhook vào). */
const phoneVariants = (local: string): string[] => [local, `84${local.slice(1)}`, `+84${local.slice(1)}`];

/**
 * Lead Ads (`leadgen`): webhook chỉ mang `leadgen_id` → gọi Graph lấy `field_data` bằng page token → tạo/ghép khách.
 * Idempotent theo `leadgen_id` (Meta gửi lại khi lỗi). Khách thuộc `default_assignee_id` của Page (cùng quy tắc webhook vào),
 * tạo khách phát outbox `contact.created` (origin `facebook_lead`) qua `PublicApiService.createContactInTx`.
 * Docs: https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving
 */
@Injectable()
export class FacebookLeadsService {
  private readonly logger = new Logger(FacebookLeadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphClient,
    private readonly pages: FacebookPagesService,
    private readonly publicApi: PublicApiService,
  ) {}

  /** Lỗi tạm (mạng/5xx của Graph) ⇒ ném để webhook trả 5xx, Meta sẽ gửi lại. Lỗi vĩnh viễn ⇒ trả kết quả. */
  async handle(change: LeadgenChange): Promise<LeadResult> {
    const { leadgen_id: leadgenId, page_id: pageId } = change;
    if (!leadgenId || !pageId || !/^\d{1,40}$/.test(leadgenId)) return 'skipped';
    if (await this.prisma.facebookLeadReceipt.findUnique({ where: { leadgen_id: leadgenId }, select: { id: true } })) return 'already_processed';
    const ctx = await this.pages.activePageWithToken(pageId);
    if (!ctx) return 'skipped';
    let lead;
    try {
      lead = await this.graph.getLead(leadgenId, ctx.token);
    } catch (err) {
      if (err instanceof GraphApiError && err.isTokenError) await this.pages.markTokenInvalid(pageId);
      // Giới hạn tần suất thường là HTTP 400 — KHÔNG được coi là vĩnh viễn, ném để webhook trả 5xx và Meta gửi lại.
      if (err instanceof GraphApiError && err.isRateLimit) throw err;
      if (err instanceof GraphApiError && (err.isTokenError || err.isPermissionError || (err.httpStatus >= 400 && err.httpStatus < 500))) {
        this.logger.warn(`Lead ${leadgenId}: không đọc được (code=${err.code}) — bỏ qua`);
        return 'skipped';
      }
      throw err;
    }
    const parsed = parseLeadFields(lead.field_data);
    const owner = await this.loadOwner(ctx.page.default_assignee_id);
    if (!owner) {
      this.logger.warn(`Lead ${leadgenId}: người nhận của Page ${pageId} không còn hoạt động`);
      await this.receipt(leadgenId, pageId, change.form_id, null, 'owner_inactive');
      return 'owner_inactive';
    }
    if (!parsed.phone && !parsed.email) {
      await this.receipt(leadgenId, pageId, change.form_id, null, 'no_contact_info');
      return 'no_contact_info';
    }
    return this.persist(ctx.page, leadgenId, change.form_id, parsed, owner);
  }

  private async loadOwner(id: number): Promise<{ id: number; team_id: number | null } | null> {
    const u = await this.prisma.user.findUnique({ where: { id }, select: { id: true, status: true, team_id: true, deleted_at: true } });
    return u && u.status === 'active' && u.deleted_at === null ? { id: u.id, team_id: u.team_id } : null;
  }

  private receipt(leadgenId: string, pageId: string, formId: string | undefined, contactId: number | null, result: string): Promise<unknown> {
    return this.prisma.facebookLeadReceipt.create({ data: { leadgen_id: leadgenId, page_id: pageId, form_id: formId?.slice(0, 40) ?? null, contact_id: contactId, result } });
  }

  private persist(
    page: { id: number; page_id: string; name: string; contact_source_id: number; project_id: number | null },
    leadgenId: string,
    formId: string | undefined,
    p: ParsedLead,
    owner: { id: number; team_id: number | null },
  ): Promise<LeadResult> {
    return this.prisma.$transaction(async (tx): Promise<LeadResult> => {
      const claimed = await tx.$queryRaw<{ id: bigint }[]>`
        INSERT INTO facebook_lead_receipts (leadgen_id, page_id, form_id, result) VALUES (${leadgenId}, ${page.page_id}, ${formId?.slice(0, 40) ?? null}, 'pending')
        ON CONFLICT (leadgen_id) DO NOTHING RETURNING id`;
      if (claimed.length === 0) return 'already_processed';
      const lockKey = p.phone ?? p.email ?? leadgenId;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const dup = await this.findDuplicate(tx, p);
      let contactId: number;
      if (dup) {
        contactId = dup.id;
      } else if (p.phone) {
        const created = await this.publicApi.createContactInTx(
          tx,
          { phone: p.phone, full_name: p.full_name, source_id: page.contact_source_id, email: p.email, project_id: page.project_id },
          owner,
          'facebook_lead',
        );
        contactId = created.id;
      } else {
        // Chỉ có email và chưa khớp khách nào: cột phone bắt buộc nên không tạo được.
        await tx.facebookLeadReceipt.update({ where: { leadgen_id: leadgenId }, data: { result: 'no_contact_info' } });
        return 'no_contact_info';
      }
      await tx.activity.create({ data: this.activity(page, formId, p, contactId, dup !== null) });
      const result = dup ? 'duplicate' : 'created';
      await tx.facebookLeadReceipt.update({ where: { leadgen_id: leadgenId }, data: { contact_id: contactId, result } });
      return result;
    });
  }

  /** Khử trùng: SĐT (mọi dạng +84/84/0) trước, rồi email (không phân biệt hoa thường). */
  private async findDuplicate(tx: Prisma.TransactionClient, p: ParsedLead): Promise<{ id: number } | null> {
    if (p.phone) {
      const byPhone = await tx.contact.findFirst({ where: { phone: { in: phoneVariants(p.phone) }, deleted_at: null }, orderBy: { id: 'asc' }, select: { id: true } });
      if (byPhone) return byPhone;
    }
    if (p.email) return tx.contact.findFirst({ where: { email: { equals: p.email, mode: 'insensitive' }, deleted_at: null }, orderBy: { id: 'asc' }, select: { id: true } });
    return null;
  }

  private activity(page: { id: number; page_id: string; name: string }, formId: string | undefined, p: ParsedLead, contactId: number, duplicate: boolean): Prisma.ActivityUncheckedCreateInput {
    const head = duplicate ? `Khách gửi lại form Lead Ads của "${page.name}"` : `Tạo từ form Lead Ads của "${page.name}"`;
    const answers = p.others.map((o) => `${o.name}: ${o.value}`).join('; ');
    return {
      contact_id: contactId,
      action: 'note',
      details: { description: `${head}${answers ? ` — ${answers}`.slice(0, 1500) : ''}`, source: 'facebook_lead' },
      metadata: { facebook_page_id: page.page_id, ...(formId ? { form_id: formId } : {}) } as Prisma.InputJsonObject,
      created_by: null,
    };
  }
}
