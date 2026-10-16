import { ForbiddenException, HttpException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { SocialAccountsService } from '../../social/social-accounts.service';
import { SocialPostsService } from '../../social/social-posts.service';
import { SocialDraftsService } from '../../social/social-drafts.service';
import { SocialQueueService } from '../../social/social-queue.service';
import { SocialSnippetsService } from '../../social/social-snippets.service';
import { SocialImportService } from '../../social/social-import.service';
import { SocialRecurrenceService } from '../../social/social-recurrence.service';
import { FacebookCommentsService } from '../../facebook/facebook-comments.service';
import { FacebookChatLinksService } from '../../facebook/facebook-chat-links.service';
import { FacebookFlowsService } from '../../facebook/facebook-flows.service';
import { FacebookBroadcastsService } from '../../facebook/facebook-broadcasts.service';
import { PaymentsService } from '../../connectors/payments.service';
import { FacebookMessengerService } from '../../facebook/facebook-messenger.service';
import { ZaloOaMessagingService } from '../../zalo-oa/zalo-oa-messaging.service';
import type { Request, Response } from 'express';
import { IntegrationAuditService, PrismaService } from '@trinity/prisma';
import { can } from '@trinity/rbac';
import { ScopeService } from '@trinity/rbac-nest';
import { ContactsService } from '../../contacts/contacts.service';
import { CustomObjectTemplatesService } from '../../custom-objects/custom-object-templates.service';
import { CustomRecordsListService } from '../../custom-objects/custom-records-list.service';
import { DealsService } from '../../deals/deals.service';
import { KanbanCardsService } from '../../kanban/cards/kanban-cards.service';
import { ActivitiesService } from '../../activities/activities.service';
import { DashboardOverviewService } from '../../reports/dashboard-overview.service';
import { DashboardChannelsService } from '../../reports/dashboard-channels.service';
import { InteractionsService } from '../../interactions/interactions.service';
import { publicBaseUrl } from '../oauth/oauth-config';
import { sanitizeForAi } from './ai-output';
import type { McpPrincipal } from './mcp-auth.service';
import { McpRateLimiter, MCP_CALLS_PER_MINUTE } from './mcp-rate-limiter';
import { loadMcpSdk } from './mcp-sdk';
import { MCP_SERVER_INSTRUCTIONS, MCP_TOOLS } from './mcp-tools.registry';
import { ForbiddenToolError, ToolUserError, type McpDeps, type ToolDef } from './tools/tool-types';
import { AiActionsService } from './actions/ai-actions.service';
import { BriefingsService } from '../../briefings/briefings.service';
import { LeadScoringService } from '../../lead-scoring/lead-scoring.service';
import { LeadIntentService } from '../../lead-scoring/lead-intent.service';
import { SetupStatusService } from '../../setup/setup-status.service';
import { OrgFeaturesService } from '../../settings/org-features.service';
import { SchemaVersionsService } from '../../custom-objects/schema-versions.service';
import { RecordRefsService } from '../../custom-objects/refs/record-refs.service';
import { ExtensionsService } from '../../extensions/extensions.service';
import { ExtensionsRuntime } from '../../extensions/extensions.runtime';
import { extensionsEnabled } from '../../extensions/extension-flags';
import { EXTENSION_TOOL_NAMES } from './tools/extension-tools';
import { extensionToolDefs } from './tools/extension-dynamic';

const MAX_TEXT = 40_000;

interface CallResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const errorResult = (text: string): CallResult => ({ isError: true, content: [{ type: 'text', text }] });

/** Đối tượng bị tác động ghi vào nhật ký: `id` (kiểu cũ/bản ghi) hoặc `action_id` (get_action_status). */
export function auditTarget(args: Record<string, unknown>): { resource?: string; resourceId?: string | number } {
  const { id, action_id: actionId } = args;
  if (typeof id === 'string') return { resource: id.split(':')[0], resourceId: id };
  if (typeof actionId === 'number') return { resource: 'ai_action_draft', resourceId: actionId };
  if (typeof id === 'number') return { resourceId: id };
  return {};
}

/**
 * Máy chủ MCP STATELESS: mỗi request HTTP dựng 1 `McpServer` + 1 transport rồi huỷ — KHÔNG giữ session trong RAM. Danh tính = người dùng của token OAuth (đã kiểm ở controller); mọi tool gọi lại service hiện có với `AuthUser`
 * đã bị gỡ `*.phone_full`.
 */
@Injectable()
export class McpServerService {
  private readonly logger = new Logger(McpServerService.name);
  private readonly deps: McpDeps;

  constructor(
    prisma: PrismaService,
    scope: ScopeService,
    contacts: ContactsService,
    deals: DealsService,
    cards: KanbanCardsService,
    activities: ActivitiesService,
    overview: DashboardOverviewService,
    actions: AiActionsService,
    private readonly audit: IntegrationAuditService,
    private readonly limiter: McpRateLimiter,
    recordLists: CustomRecordsListService,
    templates: CustomObjectTemplatesService,
    briefings: BriefingsService,
    leadScoring: LeadScoringService,
    leadIntents: LeadIntentService,
    setup: SetupStatusService,
    orgFeatures: OrgFeaturesService,
    versions: SchemaVersionsService,
    refs: RecordRefsService,
    @Optional() extensions?: ExtensionsService,
    @Optional() extRuntime?: ExtensionsRuntime,
    @Optional() socialPosts?: SocialPostsService,
    @Optional() socialAccounts?: SocialAccountsService,
    @Optional() facebookComments?: FacebookCommentsService,
    @Optional() facebookChatLinks?: FacebookChatLinksService,
    @Optional() facebookFlows?: FacebookFlowsService,
    @Optional() facebookBroadcasts?: FacebookBroadcastsService,
    @Optional() facebookMessenger?: FacebookMessengerService,
    @Optional() zaloOa?: ZaloOaMessagingService,
    @Optional() payments?: PaymentsService,
    @Optional() socialDrafts?: SocialDraftsService,
    @Optional() socialQueue?: SocialQueueService,
    @Optional() socialSnippets?: SocialSnippetsService,
    @Optional() socialImport?: SocialImportService,
    @Optional() socialRecurrence?: SocialRecurrenceService,
    @Optional() channels?: DashboardChannelsService,
    @Optional() interactions?: InteractionsService,
  ) {
    const social = socialPosts && socialAccounts && socialDrafts && socialQueue && socialSnippets && socialImport && socialRecurrence ? { posts: socialPosts, accounts: socialAccounts, drafts: socialDrafts, queue: socialQueue, snippets: socialSnippets, importer: socialImport, recurrences: socialRecurrence } : undefined;
    this.deps = { prisma, scope, contacts, deals, cards, activities, overview, actions, recordLists, templates, briefings, leadScoring, leadIntents, setup, orgFeatures, versions, refs, extensions, extRuntime, social, facebookComments, facebookChatLinks, facebookFlows, facebookBroadcasts, facebookMessenger, zaloOa, payments, channels, interactions };
  }

  /** Dựng server + đăng ký tool cho 1 request (public để test gọi trực tiếp tool qua `execute`). */
  private buildServer(principal: McpPrincipal) {
    const { McpServer, z } = loadMcpSdk();
    const server = new McpServer({ name: 'trinity-crm', version: '1.0.0' }, { instructions: MCP_SERVER_INSTRUCTIONS });
    for (const tool of this.visibleTools()) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.input(z),
          outputSchema: tool.output(z),
          annotations: { title: tool.title, ...(tool.annotations ?? { readOnlyHint: true, destructiveHint: false, idempotentHint: true }), openWorldHint: false },
        } as never,
        (async (args: Record<string, unknown>) => this.execute(tool, args ?? {}, principal)) as never,
      );
    }
    return server;
  }

  /** Tool chương trình con ẩn hoàn toàn khi cờ tắt; tool động của chương trình con `active` được gộp vào mỗi lượt `tools/list`. */
  private visibleTools(): readonly ToolDef[] {
    if (!extensionsEnabled() || !this.deps.extRuntime) return MCP_TOOLS.filter((t) => !EXTENSION_TOOL_NAMES.has(t.name));
    return [...MCP_TOOLS, ...extensionToolDefs(this.deps.extRuntime)];
  }

  /** Xử lý 1 POST /mcp (đã xác thực). */
  async handle(req: Request, res: Response, principal: McpPrincipal): Promise<void> {
    const { StreamableHTTPServerTransport } = loadMcpSdk();
    const server = this.buildServer(principal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  async execute(tool: ToolDef, args: Record<string, unknown>, principal: McpPrincipal): Promise<CallResult> {
    const started = Date.now();
    const log = (status: 'ok' | 'denied' | 'error', error?: string): Promise<void> =>
      this.audit.log({
        channel: 'mcp', action: tool.name, status, clientId: principal.clientId, userId: principal.userId, durationMs: Date.now() - started,
        ...auditTarget(args),
        error: error ?? null,
        // Che SĐT / bỏ khoá nhạy cảm trước khi ghi nhật ký (cùng chính sách webhook: không ghi SĐT thô).
        metadata: { args: sanitizeForAi(args) },
      });

    const limit = await this.limiter.hit('call', principal.userId, MCP_CALLS_PER_MINUTE);
    if (!limit.allowed) {
      await log('denied', 'rate_limited');
      return errorResult(`Quá giới hạn ${MCP_CALLS_PER_MINUTE} lời gọi/phút. Thử lại sau ${limit.retryAfterSec} giây. / Rate limit exceeded.`);
    }
    if (tool.scope && !principal.scopes.includes(tool.scope)) {
      await log('denied', `insufficient_scope:${tool.scope}`);
      return errorResult(`insufficient_scope: kết nối này chưa được cấp quyền ghi (${tool.scope}). Người dùng cần kết nối lại và bật "Cho phép AI thay đổi dữ liệu" ở màn đồng ý (Cài đặt > Kết nối & AI > Kết nối AI). / This connection lacks the ${tool.scope} scope.`);
    }
    const missing = tool.permissions.find((p) => !can(principal.user.grants, p));
    if (missing) {
      await log('denied', `missing_permission:${missing}`);
      return errorResult(`Bạn không có quyền thực hiện thao tác này (cần quyền ${missing}). / Permission denied: ${missing} required.`);
    }
    try {
      const out = await tool.run(args, { principal, deps: this.deps, baseUrl: publicBaseUrl() as string });
      await log('ok');
      return { content: [{ type: 'text', text: (out.text ?? JSON.stringify(out.structured)).slice(0, MAX_TEXT) }], structuredContent: out.structured };
    } catch (err) {
      return this.failure(err, log);
    }
  }

  private async failure(err: unknown, log: (s: 'ok' | 'denied' | 'error', e?: string) => Promise<void>): Promise<CallResult> {
    if (err instanceof ToolUserError) {
      await log('error', 'invalid_arguments');
      return errorResult(err.message);
    }
    if (err instanceof NotFoundException) {
      await log('denied', 'not_found_or_out_of_scope');
      return errorResult('Không tìm thấy bản ghi hoặc nằm ngoài phạm vi quyền của bạn. / Not found or outside your permission scope.');
    }
    if (err instanceof ForbiddenToolError || (err instanceof HttpException && err.getStatus() === 403)) {
      await log('denied', 'forbidden');
      return errorResult(err instanceof ForbiddenToolError || err instanceof ForbiddenException ? err.message : 'Bạn không có quyền thực hiện thao tác này. / Permission denied.');
    }
    if (err instanceof HttpException && err.getStatus() < 500) {
      await log('error', `http_${err.getStatus()}`);
      return errorResult(`Yêu cầu không hợp lệ: ${err.message}`);
    }
    if (err instanceof Error && !(err instanceof HttpException) && /^(query|id|contact_id)\b|SĐT|Không hỗ trợ/.test(err.message)) {
      await log('error', 'invalid_arguments');
      return errorResult(err.message);
    }
    this.logger.error(`MCP tool lỗi: ${(err as Error)?.message}`, (err as Error)?.stack);
    await log('error', 'internal_error');
    return errorResult('Lỗi hệ thống khi thực hiện yêu cầu. Vui lòng thử lại sau. / Internal error.');
  }
}
