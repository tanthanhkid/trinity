import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, InternalServerErrorException, Logger, NotFoundException, Optional } from '@nestjs/common';
import { SocialAccountsService } from '../../../social/social-accounts.service';
import { SocialPostsService } from '../../../social/social-posts.service';
import { SocialDraftsService } from '../../../social/social-drafts.service';
import { SocialQueueService } from '../../../social/social-queue.service';
import { SocialSnippetsService } from '../../../social/social-snippets.service';
import { SocialImportService } from '../../../social/social-import.service';
import { Prisma, type AiActionDraft } from '@prisma/client';
import { IntegrationAuditService, PrismaService } from '@trinity/prisma';
import { can } from '@trinity/rbac';
import { ScopeService, type AuthUser } from '@trinity/rbac-nest';
import { ActivitiesService } from '../../../activities/activities.service';
import { ContactTransferService } from '../../../contacts/contact-transfer.service';
import { ContactsService } from '../../../contacts/contacts.service';
import { CustomRecordsService } from '../../../custom-objects/custom-records.service';
import { RecordValidator } from '../../../custom-objects/record-validator.service';
import { CustomFieldsService } from '../../../custom-objects/custom-fields.service';
import { CustomObjectTemplatesService } from '../../../custom-objects/custom-object-templates.service';
import { CustomObjectsService } from '../../../custom-objects/custom-objects.service';
import { CustomViewsService } from '../../../custom-objects/custom-views.service';
import { CustomMenuService } from '../../../custom-objects/custom-menu.service';
import { OrgFeaturesService } from '../../../settings/org-features.service';
import { SetupStatusService } from '../../../setup/setup-status.service';
import { SchemaVersionsService } from '../../../custom-objects/schema-versions.service';
import type { Impact } from './impact';
import { DealsService } from '../../../deals/deals.service';
import { KanbanCardsService } from '../../../kanban/cards/kanban-cards.service';
import { NotificationsService } from '../../../notifications/notifications.service';
import { publicBaseUrl } from '../../oauth/oauth-config';
import { McpRateLimiter } from '../mcp-rate-limiter';
import type { McpPrincipal } from '../mcp-auth.service';
import { DRAFTS_PER_MINUTE, DRAFT_TTL_MS, MAX_PENDING_DRAFTS, MAX_PENDING_PER_CLIENT, REQUIRE_APPROVAL_KEY, WRITES_PER_CLIENT_PER_MINUTE, WRITES_PER_MINUTE, ActionUserError, type ActionCtx, type ActionDeps, type ActionToolDef } from './action-types';
import { actionToolByName } from './action-registry';
import { shown } from './action-helpers';
import { EXECUTION_STALE_MS, STALE_EXECUTION_ERROR, effectiveStatus, toView, type DraftView, type ViewStatus } from './ai-action-view';
import { RecordRefsService } from '../../../custom-objects/refs/record-refs.service';
import { RecordLinksService } from '../../../custom-objects/refs/record-links.service';

const ADVISORY_NS = 347;
/** Thao tác đổi cấu trúc ⇒ lưu phiên bản cấu trúc trước khi chạy. */
const STRUCTURE_TOOLS = new Set(['create_objects', 'create_object', 'update_object', 'add_field', 'update_field', 'archive_field', 'install_object_template', 'propose_workspace', 'create_view', 'update_view', 'set_menu', 'restore_structure_version']);
const norm = (s: string | null | undefined): string => String(s ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
const NOTIFY_EVENT = 'ai_action.created';

export interface DraftCreated {
  id: number;
  status: 'pending';
  summary: string;
  expires_at: Date;
  review_url: string;
  duplicate: boolean;
}

export interface ActionExecuted {
  id: number;
  status: 'executed';
  summary: string;
  result: Record<string, unknown>;
}

const errMessage = (e: unknown): string => {
  if (e instanceof HttpException) {
    const r = e.getResponse();
    const m = typeof r === 'string' ? r : (r as { message?: string | string[] })?.message;
    return Array.isArray(m) ? m.join('; ') : (m ?? e.message);
  }
  return 'Lỗi hệ thống khi thực hiện đề xuất';
};

@Injectable()
export class AiActionsService {
  private readonly logger = new Logger(AiActionsService.name);
  private readonly deps: ActionDeps;

  constructor(
    private readonly prisma: PrismaService,
    scope: ScopeService,
    contacts: ContactsService,
    cards: KanbanCardsService,
    activities: ActivitiesService,
    transfer: ContactTransferService,
    private readonly notifications: NotificationsService,
    private readonly audit: IntegrationAuditService,
    private readonly limiter: McpRateLimiter,
    records: CustomRecordsService,
    validator: RecordValidator,
    deals: DealsService,
    objects: CustomObjectsService,
    fields: CustomFieldsService,
    templates: CustomObjectTemplatesService,
    views: CustomViewsService,
    menu: CustomMenuService,
    orgFeatures: OrgFeaturesService,
    setup: SetupStatusService,
    versions: SchemaVersionsService,
    refs: RecordRefsService,
    links: RecordLinksService,
    @Optional() socialPosts?: SocialPostsService,
    @Optional() socialAccounts?: SocialAccountsService,
    @Optional() socialDrafts?: SocialDraftsService,
    @Optional() socialQueue?: SocialQueueService,
    @Optional() socialSnippets?: SocialSnippetsService,
    @Optional() socialImport?: SocialImportService,
  ) {
    const social = socialPosts && socialAccounts && socialDrafts && socialQueue && socialSnippets && socialImport ? { posts: socialPosts, accounts: socialAccounts, drafts: socialDrafts, queue: socialQueue, snippets: socialSnippets, importer: socialImport } : undefined;
    this.deps = { prisma, scope, contacts, cards, activities, transfer, records, validator, deals, objects, fields, templates, views, menu, orgFeatures, setup, versions, refs, links, social };
  }

  reviewUrl(id?: number): string {
    const base = publicBaseUrl() ?? '';
    return `${base}/ai-actions${id ? `?id=${id}` : ''}`;
  }

  /** Cài đặt "Yêu cầu duyệt thay đổi do AI": mặc định TẮT (ghi thẳng). Lỗi đọc ⇒ coi là BẬT (fail-closed: thà chờ duyệt còn hơn ghi nhầm). */
  async requiresApproval(): Promise<boolean> {
    try {
      const row = await this.prisma.setting.findUnique({ where: { key: REQUIRE_APPROVAL_KEY }, select: { value: true } });
      return row?.value === 'true';
    } catch (err) {
      this.logger.error(`Đọc cài đặt duyệt AI lỗi, dùng chế độ chờ duyệt: ${(err as Error)?.message}`);
      return true;
    }
  }

  async setRequireApproval(value: boolean, userId: number): Promise<{ require_approval: boolean }> {
    await this.prisma.setting.upsert({
      where: { key: REQUIRE_APPROVAL_KEY },
      update: { value: String(value), updated_by: userId },
      create: { key: REQUIRE_APPROVAL_KEY, value: String(value), updated_by: userId },
    });
    await this.audit.log({ channel: 'mcp', action: 'ai_action.setting', status: 'ok', userId, resource: 'setting', resourceId: REQUIRE_APPROVAL_KEY, metadata: { require_approval: value } });
    return { require_approval: value };
  }

  /**
   * GHI THẲNG (mặc định): kiểm quyền + phạm vi + DTO bằng ĐÚNG `tool.prepare` + `run` của luồng duyệt, rồi chạy `tool.execute` ngay
   * với người dùng đã kết nối. Vẫn ghi 1 dòng `ai_action_drafts` (nhận `approved` trước khi chạy → `executed` + result sau khi xong,
   * hoặc `failed` + lý do) để có lịch sử "Hoạt động AI", nhật ký audit và phiên bản cấu trúc như luồng duyệt.
   */
  async executeNow(tool: ActionToolDef, args: Record<string, unknown>, principal: McpPrincipal): Promise<ActionExecuted> {
    const hit = await this.limiter.hit('write', principal.userId, WRITES_PER_MINUTE);
    if (!hit.allowed) throw new ActionUserError(`Ghi dữ liệu quá nhanh (tối đa ${WRITES_PER_MINUTE}/phút). Thử lại sau ${hit.retryAfterSec} giây.`);
    const appHit = await this.limiter.hit(`write_app:${principal.clientId}`, principal.userId, WRITES_PER_CLIENT_PER_MINUTE);
    if (!appHit.allowed) throw new ActionUserError(`Ứng dụng AI này ghi quá nhanh (tối đa ${WRITES_PER_CLIENT_PER_MINUTE}/phút). Thử lại sau ${appHit.retryAfterSec} giây.`);
    const ctx: ActionCtx = { deps: this.deps, user: principal.user };
    const prepared = await tool.prepare(args, ctx);
    const now = new Date();
    const row = await this.prisma.aiActionDraft.create({
      data: {
        user_id: principal.userId, client_id: principal.clientId, tool: tool.name, params: prepared.params as Prisma.InputJsonObject, summary: prepared.summary.slice(0, 1000),
        details: prepared.details as unknown as Prisma.InputJsonArray, ...(prepared.impact ? { impact: prepared.impact as unknown as Prisma.InputJsonObject } : {}),
        status: 'approved', decided_at: now, expires_at: new Date(now.getTime() + DRAFT_TTL_MS),
      },
    });
    let result: Record<string, unknown>;
    try {
      if (STRUCTURE_TOOLS.has(row.tool)) await this.deps.versions.save(row.id, row.tool, row.summary, principal.userId);
      result = await this.run(row, principal.user);
    } catch (err) {
      await this.fail(row, principal.userId, err, 'ai_action.execute');
      throw this.toHttp(err);
    }
    // Đã thực thi xong: lỗi ghi lịch sử KHÔNG được biến thành "thất bại" (thao tác đã xảy ra).
    await this.prisma.aiActionDraft.update({ where: { id: row.id }, data: { status: 'executed', result: result as Prisma.InputJsonObject } }).catch((e: unknown) => this.logger.error(`Ghi kết quả thao tác AI #${row.id} lỗi: ${String(e)}`));
    await this.auditDecision('ai_action.execute', 'ok', row, principal.userId).catch(() => undefined);
    return { id: row.id, status: 'executed', summary: row.summary, result };
  }

  /** TẠO BẢN NHÁP (không ghi dữ liệu nghiệp vụ). Quyền + phạm vi + DTO đã kiểm ở `tool.prepare` (báo lỗi sớm). */
  async createDraft(tool: ActionToolDef, args: Record<string, unknown>, principal: McpPrincipal): Promise<DraftCreated> {
    const hit = await this.limiter.hit('draft', principal.userId, DRAFTS_PER_MINUTE);
    if (!hit.allowed) throw new ActionUserError(`Tạo đề xuất quá nhanh (tối đa ${DRAFTS_PER_MINUTE}/phút). Thử lại sau ${hit.retryAfterSec} giây.`);
    const ctx: ActionCtx = { deps: this.deps, user: principal.user };
    const prepared = await tool.prepare(args, ctx);
    const created = await this.insertDraft(tool, prepared, principal);
    if (!created.duplicate) void this.notify(principal.userId, created.id, prepared.summary);
    await this.audit.log({
      channel: 'mcp', action: 'ai_action.draft', status: 'ok', clientId: principal.clientId, userId: principal.userId,
      resource: 'ai_action_draft', resourceId: created.id, metadata: { tool: tool.name, duplicate: created.duplicate, summary: prepared.summary },
    });
    return created;
  }

  private async insertDraft(tool: ActionToolDef, p: { params: Record<string, unknown>; summary: string; details: unknown[]; impact?: Impact }, principal: McpPrincipal): Promise<DraftCreated> {
    return this.prisma.$transaction(async (tx) => {
      // Tuần tự hoá theo user: đếm + chèn không bị 2 request song song cùng vượt trần.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_NS}::int, ${principal.userId}::int)`;
      const now = new Date();
      const live = { user_id: principal.userId, status: 'pending', expires_at: { gt: now } };
      const dup = await tx.aiActionDraft.findFirst({ where: { ...live, client_id: principal.clientId, tool: tool.name, params: { equals: p.params as Prisma.InputJsonObject } }, select: { id: true, summary: true, expires_at: true } });
      if (dup) return { id: dup.id, status: 'pending' as const, summary: dup.summary, expires_at: dup.expires_at, review_url: this.reviewUrl(dup.id), duplicate: true };
      const pending = await tx.aiActionDraft.count({ where: live });
      const byClient = await tx.aiActionDraft.count({ where: { ...live, client_id: principal.clientId } });
      if (byClient >= MAX_PENDING_PER_CLIENT) {
        throw new ActionUserError(`Ứng dụng này đang có ${byClient} đề xuất chờ duyệt (tối đa ${MAX_PENDING_PER_CLIENT}). Hãy đợi người dùng duyệt/từ chối rồi mới tạo thêm. KHÔNG tạo hàng loạt.`);
      }
      if (pending >= MAX_PENDING_DRAFTS) {
        throw new ActionUserError(`Bạn đang có ${pending} đề xuất chờ duyệt (tối đa ${MAX_PENDING_DRAFTS}). Hãy duyệt/từ chối bớt trong Trinity rồi thử lại. KHÔNG tạo thêm hàng loạt.`);
      }
      const row = await tx.aiActionDraft.create({
        data: { user_id: principal.userId, client_id: principal.clientId, tool: tool.name, params: p.params as Prisma.InputJsonObject, summary: p.summary.slice(0, 1000), details: p.details as Prisma.InputJsonArray, ...(p.impact ? { impact: p.impact as unknown as Prisma.InputJsonObject } : {}), expires_at: new Date(now.getTime() + DRAFT_TTL_MS) },
        select: { id: true, summary: true, expires_at: true },
      });
      return { id: row.id, status: 'pending' as const, summary: row.summary, expires_at: row.expires_at, review_url: this.reviewUrl(row.id), duplicate: false };
    });
  }

  private async notify(userId: number, id: number, summary: string): Promise<void> {
    try {
      await this.notifications.createPendingLogs([userId], NOTIFY_EVENT, { title: 'AI đề xuất một thao tác — chờ bạn duyệt', body: shown(summary, 200), action_url: `/ai-actions?id=${id}` });
    } catch (err) {
      this.logger.error(`Không gửi được thông báo đề xuất AI #${id}: ${(err as Error)?.message}`);
    }
  }

  /** `get_action_status` cho AI: chỉ nháp của CHÍNH người dùng + CHÍNH ứng dụng đã tạo nó. */
  async statusFor(principal: McpPrincipal, id: number) {
    const row = await this.prisma.aiActionDraft.findFirst({ where: { id, user_id: principal.userId, client_id: principal.clientId } });
    if (!row) throw new NotFoundException('Không tìm thấy đề xuất');
    const v = toView(row, null);
    // Lý do lỗi CHI TIẾT chỉ người duyệt thấy trên web: nếu trả cho AI thì "SĐT đã tồn tại"… thành oracle dò dữ liệu mà AI không được tra trực tiếp.
    const error = v.status === 'failed' ? 'Không thực hiện được — lý do đã hiển thị cho người dùng trong Trinity (mục Hoạt động AI).' : null;
    return { id: v.id, tool: v.tool, status: v.status, summary: v.summary, result: v.result, error, decided_at: v.decided_at, expires_at: v.expires_at };
  }

  private async clientNames(rows: AiActionDraft[]): Promise<Map<string, string>> {
    const ids = Array.from(new Set(rows.map((r) => r.client_id)));
    const cs = ids.length ? await this.prisma.oauthClient.findMany({ where: { client_id: { in: ids } }, select: { client_id: true, name: true } }) : [];
    return new Map(cs.map((c) => [c.client_id, c.name]));
  }

  async list(userId: number, q: { status?: string; cursor?: number; limit: number }): Promise<{ data: DraftView[]; next_cursor: number | null }> {
    const now = new Date();
    const where: Prisma.AiActionDraftWhereInput = { user_id: userId };
    if (q.status === 'pending') Object.assign(where, { status: 'pending', expires_at: { gt: now } });
    else if (q.status === 'expired') Object.assign(where, { OR: [{ status: 'expired' }, { status: 'pending', expires_at: { lte: now } }] });
    else if (q.status) Object.assign(where, { status: q.status });
    const rows = await this.prisma.aiActionDraft.findMany({ where, orderBy: { id: 'desc' }, take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}) });
    const more = rows.length > q.limit;
    const page = more ? rows.slice(0, q.limit) : rows;
    const names = await this.clientNames(page);
    return { data: page.map((r) => toView(r, names.get(r.client_id) ?? null)), next_cursor: more ? page[page.length - 1].id : null };
  }

  /**
   * Hoạt động AI cho chính AI đọc lại (tool list_ai_activity): cùng bảng dữ liệu với trang "Hoạt động AI". `all_users` = mọi người
   * trong công ty (người gọi phải có integrations.ai_admin — kiểm ở tool). Lý do lỗi chi tiết KHÔNG trả cho AI (như statusFor).
   */
  async activity(q: { userId: number | null; from: Date; to: Date; status?: string; cursor?: number; limit: number }) {
    const where: Prisma.AiActionDraftWhereInput = { created_at: { gte: q.from, lt: q.to } };
    if (q.userId !== null) where.user_id = q.userId;
    if (q.status) where.status = q.status;
    const rows = await this.prisma.aiActionDraft.findMany({ where, orderBy: { id: 'desc' }, take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}) });
    const more = rows.length > q.limit;
    const page = more ? rows.slice(0, q.limit) : rows;
    const names = await this.clientNames(page);
    const userIds = Array.from(new Set(page.map((r) => r.user_id)));
    const users = userIds.length ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, full_name: true } }) : [];
    const who = new Map(users.map((u) => [u.id, u.full_name]));
    const items = page.map((r) => {
      const v = toView(r, names.get(r.client_id) ?? null);
      return {
        action_id: v.id, at: v.created_at, user: who.get(r.user_id) ?? null, app: v.client_name, tool: v.tool, what: v.tool_label, summary: v.summary, status: v.status,
        result: v.result, error: v.status === 'failed' ? 'Không thực hiện được — lý do hiển thị cho người dùng trong Trinity (mục Hoạt động AI).' : null,
        open_at: `/ai-actions?id=${v.id}`,
      };
    });
    return { items, next_cursor: more ? page[page.length - 1].id : null };
  }

  async pendingCount(userId: number): Promise<number> {
    return this.prisma.aiActionDraft.count({ where: { user_id: userId, status: 'pending', expires_at: { gt: new Date() } } });
  }

  private async own(userId: number, id: number): Promise<AiActionDraft> {
    const row = await this.prisma.aiActionDraft.findFirst({ where: { id, user_id: userId } });
    if (!row) throw new NotFoundException('Không tìm thấy đề xuất');
    return row;
  }

  async get(userId: number, id: number): Promise<DraftView> {
    const row = await this.own(userId, id);
    return toView(row, (await this.clientNames([row])).get(row.client_id) ?? null);
  }

  async reject(user: AuthUser, id: number): Promise<DraftView> {
    const claimed = await this.prisma.aiActionDraft.updateMany({ where: { id, user_id: user.userId, status: 'pending' }, data: { status: 'rejected', decided_at: new Date() } });
    const row = await this.own(user.userId, id);
    if (claimed.count !== 1) throw new ConflictException(this.stateMessage(row));
    await this.auditDecision('ai_action.reject', 'ok', row, user.userId);
    return this.get(user.userId, id);
  }

  private stateMessage(row: AiActionDraft): string {
    const st = effectiveStatus(row);
    const text: Record<ViewStatus, string> = {
      pending: 'Đề xuất đang được xử lý',
      executing: 'Đề xuất đang được thực hiện (đã duyệt trước đó)',
      approved: 'Đề xuất này đã được duyệt trước đó',
      executed: 'Thao tác này đã được thực hiện',
      rejected: 'Đề xuất này đã bị từ chối',
      expired: 'Đề xuất đã hết hạn (quá 24 giờ) — hãy nhờ AI tạo lại',
      failed: 'Đề xuất này đã được thử thực hiện nhưng thất bại — hãy nhờ AI tạo lại',
    };
    return text[st];
  }

  /**
   * DUYỆT: chạy qua ĐÚNG service nghiệp vụ với `AuthUser` của người duyệt (= chủ nháp).
   * Chống duyệt 2 lần/TOCTOU: "nhận" nháp bằng UPDATE nguyên tử `pending → approved` (kèm kiểm hạn) TRƯỚC khi thực thi —
   * chỉ 1 request thắng, thực thi tối đa MỘT lần. Quyền + phạm vi kiểm LẠI ở đây (quyền có thể đã đổi từ lúc tạo nháp).
   */
  async approve(user: AuthUser, id: number, confirmText?: string): Promise<DraftView> {
    // đổi cấu trúc có bản ghi bị ảnh hưởng ⇒ phải gõ ĐÚNG tên bảng (kiểm ở BE, trước khi nhận duyệt).
    const pre = await this.own(user.userId, id);
    const need = (pre.impact as { confirm_label?: string | null } | null)?.confirm_label;
    if (need && norm(confirmText) !== norm(need)) {
      throw new BadRequestException(`Đề xuất này ảnh hưởng tới dữ liệu đang có — hãy gõ đúng tên bảng “${need}” để xác nhận.`);
    }
    const claimed = await this.prisma.aiActionDraft.updateMany({
      where: { id, user_id: user.userId, status: 'pending', expires_at: { gt: new Date() } },
      data: { status: 'approved', decided_at: new Date() },
    });
    const row = await this.own(user.userId, id);
    if (claimed.count !== 1) {
      if (row.status === 'pending') await this.prisma.aiActionDraft.updateMany({ where: { id, status: 'pending' }, data: { status: 'expired', decided_at: new Date() } });
      throw new ConflictException(this.stateMessage(row));
    }
    let result: Record<string, unknown>;
    try {
      // chụp cấu trúc TRƯỚC khi đổi để quay lui được; không chụp được thì KHÔNG đổi.
      if (STRUCTURE_TOOLS.has(row.tool)) await this.deps.versions.save(row.id, row.tool, row.summary, user.userId);
      result = await this.run(row, user);
    } catch (err) {
      await this.fail(row, user.userId, err);
      throw this.toHttp(err);
    }
    // Đã thực thi xong: lỗi ghi `result`/nhật ký KHÔNG được biến thành "thất bại" (thao tác đã xảy ra).
    await this.prisma.aiActionDraft.update({ where: { id }, data: { result: result as Prisma.InputJsonObject } }).catch((e: unknown) => this.logger.error(`Ghi kết quả đề xuất #${id} lỗi: ${String(e)}`));
    await this.auditDecision('ai_action.approve', 'ok', row, user.userId).catch(() => undefined);
    return this.get(user.userId, id);
  }

  private async run(row: AiActionDraft, user: AuthUser): Promise<Record<string, unknown>> {
    const tool = actionToolByName(row.tool);
    if (!tool) throw new BadRequestException('Loại đề xuất không còn được hỗ trợ');
    const missing = tool.permissions.find((p) => !can(user.grants, p));
    if (missing) throw new ForbiddenException(`Bạn không còn quyền thực hiện thao tác này (cần quyền ${missing})`);
    return tool.execute(row.params as Record<string, unknown>, { deps: this.deps, user }, row.id);
  }

  private async fail(row: AiActionDraft, userId: number, err: unknown, action = 'ai_action.approve'): Promise<void> {
    const msg = shown(errMessage(err), 900);
    if (!(err instanceof HttpException)) this.logger.error(`Duyệt đề xuất AI #${row.id} lỗi: ${(err as Error)?.message}`, (err as Error)?.stack);
    await this.prisma.aiActionDraft.update({ where: { id: row.id }, data: { status: 'failed', error: msg } }).catch(() => undefined);
    await this.auditDecision(action, err instanceof ForbiddenException || err instanceof NotFoundException ? 'denied' : 'error', row, userId, msg);
  }

  private toHttp(err: unknown): HttpException {
    if (err instanceof HttpException && err.getStatus() < 500) return err;
    return new InternalServerErrorException('Không thực hiện được đề xuất do lỗi hệ thống. Đề xuất đã được đánh dấu thất bại.');
  }

  private auditDecision(action: string, status: 'ok' | 'denied' | 'error', row: AiActionDraft, userId: number, error?: string): Promise<void> {
    return this.audit.log({
      channel: 'mcp', action, status, clientId: row.client_id, userId, resource: 'ai_action_draft', resourceId: row.id, error: error ?? null,
      metadata: { tool: row.tool, decided_by: userId, summary: row.summary },
    });
  }

  /** Job: nháp chờ quá hạn → `expired`; nháp đã xong >90 ngày bị xoá. Trả số dòng. */
  async expireOverdue(now = Date.now()): Promise<{ expired: number; purged: number; stale: number }> {
    const expired = await this.prisma.aiActionDraft.updateMany({ where: { status: 'pending', expires_at: { lte: new Date(now) } }, data: { status: 'expired', decided_at: new Date(now) } });
    // Đã nhận duyệt nhưng KHÔNG có kết quả quá 5 phút = tiến trình chết giữa chừng ⇒ ghi nhận `failed` (kết quả không rõ).
    const stale = await this.prisma.aiActionDraft.updateMany({ where: { status: 'approved', result: { equals: Prisma.DbNull }, decided_at: { lt: new Date(now - EXECUTION_STALE_MS) } }, data: { status: 'failed', error: STALE_EXECUTION_ERROR } });
    const purged = await this.prisma.aiActionDraft.deleteMany({ where: { status: { not: 'pending' }, created_at: { lt: new Date(now - 90 * 24 * 60 * 60 * 1000) } } });
    return { expired: expired.count, purged: purged.count, stale: stale.count };
  }
}
