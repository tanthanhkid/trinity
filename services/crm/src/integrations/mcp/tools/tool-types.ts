import type { PrismaService } from '@trinity/prisma';
import type { Permission } from '@trinity/rbac';
import type { ScopeService } from '@trinity/rbac-nest';
import type { CustomObjectTemplatesService } from '../../../custom-objects/custom-object-templates.service';
import type { CustomRecordsListService } from '../../../custom-objects/custom-records-list.service';
import type { ContactsService } from '../../../contacts/contacts.service';
import type { DealsService } from '../../../deals/deals.service';
import type { KanbanCardsService } from '../../../kanban/cards/kanban-cards.service';
import type { ActivitiesService } from '../../../activities/activities.service';
import type { DashboardOverviewService } from '../../../reports/dashboard-overview.service';
import type { AiActionsService } from '../actions/ai-actions.service';
import type { BriefingsService } from '../../../briefings/briefings.service';
import type { LeadScoringService } from '../../../lead-scoring/lead-scoring.service';
import type { LeadIntentService } from '../../../lead-scoring/lead-intent.service';
import type { McpPrincipal } from '../mcp-auth.service';
import type { SetupStatusService } from '../../../setup/setup-status.service';
import type { OrgFeaturesService } from '../../../settings/org-features.service';
import type { SchemaVersionsService } from '../../../custom-objects/schema-versions.service';
import type { z as ZType } from 'zod';
import type { RecordRefsService } from '../../../custom-objects/refs/record-refs.service';
import type { ExtensionsService } from '../../../extensions/extensions.service';
import type { ExtensionsRuntime } from '../../../extensions/extensions.runtime';
import type { SocialAccountsService } from '../../../social/social-accounts.service';
import type { SocialPostsService } from '../../../social/social-posts.service';
import type { SocialDraftsService } from '../../../social/social-drafts.service';
import type { SocialQueueService } from '../../../social/social-queue.service';
import type { SocialSnippetsService } from '../../../social/social-snippets.service';
import type { SocialImportService } from '../../../social/social-import.service';
import type { SocialRecurrenceService } from '../../../social/social-recurrence.service';
import type { FacebookCommentsService } from '../../../facebook/facebook-comments.service';
import type { FacebookChatLinksService } from '../../../facebook/facebook-chat-links.service';
import type { FacebookFlowsService } from '../../../facebook/facebook-flows.service';
import type { FacebookBroadcastsService } from '../../../facebook/facebook-broadcasts.service';
import type { PaymentsService } from '../../../connectors/payments.service';
import type { FacebookMessengerService } from '../../../facebook/facebook-messenger.service';
import type { ZaloOaMessagingService } from '../../../zalo-oa/zalo-oa-messaging.service';

export interface McpDeps {
  prisma: PrismaService;
  scope: ScopeService;
  contacts: ContactsService;
  deals: DealsService;
  cards: KanbanCardsService;
  activities: ActivitiesService;
  overview: DashboardOverviewService;
  /** thao tác ghi của AI: chạy ngay theo quyền người dùng (mặc định) hoặc tạo bản nháp chờ duyệt (khi bật "Yêu cầu duyệt"). */
  actions: AiActionsService;
  /** đọc bản ghi của bảng tuỳ biến (đúng service + phạm vi của giao diện web). */
  recordLists: CustomRecordsListService;
  /** danh sách mẫu ngành (chỉ quản trị viên cấu trúc). */
  templates: CustomObjectTemplatesService;
  /** Dữ liệu bản tin cho agent tự viết + lưu bản tin của chính người dùng (Trinity không tự gọi AI). */
  briefings: BriefingsService;
  /** Cờ tính năng chấm điểm lead. */
  leadScoring: LeadScoringService;
  /** Lead cần chấm ý định + ghi điểm ý định do agent chấm. */
  leadIntents: LeadIntentService;
  /** trạng thái dựng quy trình + tính năng đang bật (get_setup_guide, complete_setup). */
  setup: SetupStatusService;
  orgFeatures: OrgFeaturesService;
  /** phiên bản cấu trúc (list_structure_versions). */
  versions: SchemaVersionsService;
  /** Mã chung: tra mã (HS001) / tên → bản ghi theo quyền xem (find_by_code, get_record theo mã). */
  refs: RecordRefsService;
  /** Chương trình con (agent tự mở rộng): kho + luồng nháp–duyệt; chỉ có khi module được nối (test cũ không cần). */
  extensions?: ExtensionsService;
  extRuntime?: ExtensionsRuntime;
  /** Đăng đa kênh (Facebook Page…): kênh đã liên kết + bài/lịch đăng + bài nháp; chỉ có khi module được nối. */
  social?: { posts: SocialPostsService; accounts: SocialAccountsService; drafts: SocialDraftsService; queue: SocialQueueService; snippets: SocialSnippetsService; importer: SocialImportService; recurrences: SocialRecurrenceService };
  /** Bình luận Fanpage + luật tự xử lý (chỉ đọc); chỉ có khi module Facebook được nối. */
  facebookComments?: FacebookCommentsService;
  facebookChatLinks?: FacebookChatLinksService;
  facebookFlows?: FacebookFlowsService;
  facebookBroadcasts?: FacebookBroadcastsService;
  /** Hộp thư Messenger / Zalo OA — trả lời khách từ AI (list_unanswered_messages, reply_to_customer). */
  facebookMessenger?: FacebookMessengerService;
  zaloOa?: ZaloOaMessagingService;
  /** Yêu cầu thanh toán + tự khớp tiền (SePay…); chỉ có khi module Connectors được nối. */
  payments?: PaymentsService;
}

export interface ToolContext {
  principal: McpPrincipal;
  deps: McpDeps;
  /** URL gốc công khai (dùng làm `url` trích dẫn cho ChatGPT). */
  baseUrl: string;
}

export type ZodShape = Record<string, ZType.ZodType>;
export type Z = typeof ZType;

/** Kết quả 1 tool: `structured` (khớp outputSchema) + `text` (cho client không đọc structuredContent). */
export interface ToolOutput {
  structured: Record<string, unknown>;
  text?: string;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  /** Cần ĐỦ MỌI quyền này (kiểm bằng `can()` trên grants của người dùng). */
  permissions: Permission[];
  /** Scope OAuth cần có ngoài `crm.read` (tool ghi dữ liệu ⇒ `crm.write`). Thiếu ⇒ lỗi `insufficient_scope`. */
  scope?: 'crm.write';
  /** Mặc định chỉ đọc (`readOnlyHint:true`). Tool ghi khai báo đúng `readOnlyHint:false` + `destructiveHint`/`idempotentHint`. */
  annotations?: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };
  input: (z: Z) => ZodShape;
  output: (z: Z) => ZodShape;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>;
}

export const idPage = (z: Z) => ({
  limit: z.number().int().min(1).max(50).optional().describe('Số bản ghi tối đa (1-50, mặc định 20) / Max records'),
  cursor: z.number().int().min(1).max(2_147_483_647).optional().describe('Con trỏ phân trang: next_cursor của trang trước / Pagination cursor'),
});

export const clampLimit = (v: unknown, def = 20): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : def;
  return Math.min(Math.max(n, 1), 50);
};

export const INT32_MAX = 2_147_483_647;
export const optInt = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= INT32_MAX ? v : undefined);

/**
 * Chặn oracle dò chữ số: bộ lọc văn bản (tên, tiêu đề) khớp bằng `contains` mà phản hồi che SĐT — nhưng việc KHỚP không che,
 * nên gọi lặp "0901", "09012"… lột được dãy số. Mọi tham số chuỗi dùng để KHỚP phải qua hàm này: ≥ 4 chữ số (cho phép ≤ 3
 * ký tự phân cách xen giữa, đã chuẩn hoá NFKC) ⇒ từ chối.
 */
export function rejectDigitProbe(q: string): void {
  const n = q.normalize('NFKC').replace(/[\u200b-\u200f\u2060\ufeff]/g, '');
  if (/\d[\s().\-_/,+]{0,3}\d[\s().\-_/,+]{0,3}\d[\s().\-_/,+]{0,3}\d/.test(n)) {
    throw new Error('Không hỗ trợ tìm theo chuỗi có nhiều chữ số — SĐT/số định danh luôn bị che với AI. Hãy tìm theo tên.');
  }
}
export const optStr = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** Lỗi "thiếu quyền" của tool (khác lỗi hệ thống) — wrapper ghi nhật ký `denied` và trả lỗi tool rõ ràng. */
export class ForbiddenToolError extends Error {}

/** Lỗi AI/người dùng sửa được (vượt giới hạn, tham số sai) — thông điệp trả nguyên văn cho AI, KHÔNG coi là lỗi hệ thống. */
export class ToolUserError extends Error {}
