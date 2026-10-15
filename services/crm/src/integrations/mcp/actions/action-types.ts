import type { PrismaService } from '@trinity/prisma';
import type { Permission } from '@trinity/rbac';
import type { AuthUser, ScopeService } from '@trinity/rbac-nest';
import type { ActivitiesService } from '../../../activities/activities.service';
import type { ContactTransferService } from '../../../contacts/contact-transfer.service';
import type { CustomRecordsService } from '../../../custom-objects/custom-records.service';
import type { RecordValidator } from '../../../custom-objects/record-validator.service';
import type { CustomFieldsService } from '../../../custom-objects/custom-fields.service';
import type { CustomObjectTemplatesService } from '../../../custom-objects/custom-object-templates.service';
import type { CustomObjectsService } from '../../../custom-objects/custom-objects.service';
import type { DealsService } from '../../../deals/deals.service';
import type { ContactsService } from '../../../contacts/contacts.service';
import type { KanbanCardsService } from '../../../kanban/cards/kanban-cards.service';
import type { CustomViewsService } from '../../../custom-objects/custom-views.service';
import type { CustomMenuService } from '../../../custom-objects/custom-menu.service';
import type { OrgFeaturesService } from '../../../settings/org-features.service';
import type { SetupStatusService } from '../../../setup/setup-status.service';
import type { SchemaVersionsService } from '../../../custom-objects/schema-versions.service';
import type { Z, ZodShape } from '../tools/tool-types';
import type { RecordRefsService } from '../../../custom-objects/refs/record-refs.service';
import type { RecordLinksService } from '../../../custom-objects/refs/record-links.service';
import type { SocialAccountsService } from '../../../social/social-accounts.service';
import type { SocialPostsService } from '../../../social/social-posts.service';
import type { SocialDraftsService } from '../../../social/social-drafts.service';
import type { SocialQueueService } from '../../../social/social-queue.service';
import type { SocialSnippetsService } from '../../../social/social-snippets.service';
import type { SocialImportService } from '../../../social/social-import.service';
import type { SocialRecurrenceService } from '../../../social/social-recurrence.service';

/** Service nghiệp vụ mà đề xuất của AI sẽ chạy qua khi người dùng duyệt (đúng service của giao diện web). */
export interface ActionDeps {
  prisma: PrismaService;
  scope: ScopeService;
  contacts: ContactsService;
  cards: KanbanCardsService;
  activities: ActivitiesService;
  transfer: ContactTransferService;
  /** ghi bản ghi tuỳ biến + validate (đúng service của giao diện web). */
  records: CustomRecordsService;
  validator: RecordValidator;
  /** ghi deal qua service nghiệp vụ sẵn có. */
  deals: DealsService;
  /** sửa cấu trúc bảng tuỳ biến (chỉ người có custom_objects.manage; qua nháp-duyệt). */
  objects: CustomObjectsService;
  fields: CustomFieldsService;
  templates: CustomObjectTemplatesService;
  /** màn xem + menu bảng tuỳ biến. */
  views: CustomViewsService;
  menu: CustomMenuService;
  /** gói dựng bật/tắt tính năng + chuyển trạng thái dựng. */
  orgFeatures: OrgFeaturesService;
  setup: SetupStatusService;
  /** phiên bản cấu trúc để quay lui. */
  versions: SchemaVersionsService;
  /** Mã chung + gắn thẻ: tra mã/khoá → bản ghi (theo quyền), ghi cạnh liên kết. */
  refs: RecordRefsService;
  links: RecordLinksService;
  /** Đăng đa kênh (Facebook Page…): kênh đã liên kết + bài/lịch đăng; chỉ có khi module được nối. */
  social?: { posts: SocialPostsService; accounts: SocialAccountsService; drafts: SocialDraftsService; queue: SocialQueueService; snippets: SocialSnippetsService; importer: SocialImportService; recurrences: SocialRecurrenceService };
}

export interface ActionCtx {
  deps: ActionDeps;
  /** Ghi thẳng / tạo nháp: người dùng đã gỡ `*.phone_full` (AI). Lúc DUYỆT: người dùng thật với grants hiện tại. */
  user: AuthUser;
}

/** 1 dòng chi tiết cho người duyệt đọc — văn bản THUẦN (FE không render HTML). */
export interface DetailLine {
  label: string;
  value: string;
}

export interface PreparedAction {
  /** Tham số đã chuẩn hoá theo DTO của service nghiệp vụ (có thể chứa SĐT đầy đủ — không bao giờ trả ra API). */
  params: Record<string, unknown>;
  summary: string;
  details: DetailLine[];
  /** đổi cấu trúc ⇒ ảnh hưởng (số bản ghi, trường/trạng thái bị ảnh hưởng, tên bảng phải gõ để xác nhận). */
  impact?: import('./impact').Impact;
}

export interface ActionToolDef {
  name: string;
  /** Nhãn tiếng Việt hiển thị ở màn duyệt. */
  label: string;
  title: string;
  description: string;
  /** Cần ĐỦ MỌI quyền này — kiểm lúc tạo nháp VÀ lúc duyệt. */
  permissions: Permission[];
  destructive: boolean;
  idempotent: boolean;
  input: (z: Z) => ZodShape;
  /** Kiểm tham số theo DTO + quyền/phạm vi NGAY lúc tạo nháp; ném lỗi (400/403/404) nếu sai. KHÔNG ghi dữ liệu. */
  prepare: (args: Record<string, unknown>, ctx: ActionCtx) => Promise<PreparedAction>;
  /** Chạy qua service nghiệp vụ với AuthUser của người duyệt. Trả kết quả gọn (chỉ id) lưu vào `result`. */
  execute: (params: Record<string, unknown>, ctx: ActionCtx, draftId: number) => Promise<Record<string, unknown>>;
}

/** Lỗi người dùng/AI có thể sửa (vượt giới hạn, tham số sai) — thông điệp trả nguyên văn cho AI. */
export class ActionUserError extends Error {}

export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_PENDING_DRAFTS = 50;
/** Mỗi ỨNG DỤNG AI (client OAuth) tối đa ngần này đề xuất chờ — một client bị prompt-injection không chiếm hết hạn mức của người dùng. */
export const MAX_PENDING_PER_CLIENT = 20;
export const DRAFTS_PER_MINUTE = 10;
/** Ghi thẳng (chế độ mặc định): trần theo NGƯỜI DÙNG và theo ỨNG DỤNG AI (client OAuth) mỗi phút — một client bị prompt-injection không xả hết hạn mức. */
export const WRITES_PER_MINUTE = 30;
export const WRITES_PER_CLIENT_PER_MINUTE = 20;
/** Khoá Setting KV: `true` ⇒ AI chỉ tạo nháp chờ duyệt (luồng cũ). Vắng/khác ⇒ ghi thẳng. */
export const REQUIRE_APPROVAL_KEY = 'ai_require_approval';
export const NOTE_MAX = 2000;
