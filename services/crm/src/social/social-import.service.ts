import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import type { AuthUser } from '@trinity/rbac-nest';
import { NO_QUEUE_SLOTS, SocialQueueService } from './social-queue.service';
import { SocialDraftsService, type DraftInput } from './social-drafts.service';
import { SocialPostsService, type CreatePostInput } from './social-posts.service';
import { IMPORT_MAX_ROWS, parseCsv, parseVnTime, type ImportRowInput } from './social-csv';
import { MAX_MEDIA_PER_POST, MAX_SCHEDULE_AHEAD_MS } from './social.config';
import { normalizeUtm, type UtmInput } from './social-utm';

const MINUTE = 60_000;
const MAX_TARGETS = 20;
/** Lúc nhập thật: giờ hẹn còn dưới ngần này thì bỏ dòng (tránh `create` coi là đã qua và đăng ngay). */
const IMPORT_MIN_LEAD_MS = 20_000;

export type ImportMode = 'drafts' | 'schedule';
export const isImportMode = (m: unknown): m is ImportMode => m === 'drafts' || m === 'schedule';

export interface RowPlan {
  /** Số dòng (CSV: dòng trong tệp, tiêu đề là dòng 1). */
  row: number;
  ok: boolean;
  errors: string[];
  warnings: string[];
  preview: {
    channels: Array<{ account_id: number; name: string; network: string }>;
    scheduled_at: string | null;
    use_queue: boolean;
    content_excerpt: string;
  };
}

export interface ImportPlan {
  mode: ImportMode;
  /** Băm các dòng đã chuẩn hoá + chế độ; gửi lại khi nhập để chắc nhập đúng cái đã xem. */
  plan_hash: string;
  total: number;
  ok_count: number;
  error_count: number;
  rows: RowPlan[];
  unknown_columns?: string[];
}

export interface ImportResult {
  mode: ImportMode;
  created: Array<{ row: number; id: number }>;
  skipped: Array<{ row: number; errors: string[] }>;
}

interface Item {
  plan: RowPlan;
  post?: CreatePostInput;
  draft?: DraftInput;
  /** Dạng chuẩn hoá để băm (không gồm khung hàng đợi — khung đổi theo thời gian). */
  norm: Record<string, unknown>;
  queue: boolean;
}

const excerpt = (s: string): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
};

/** Lỗi 4xx của service là lỗi dòng (hiện cho người dùng); lỗi khác không lộ chi tiết nội bộ. */
const rowMessage = (e: unknown): string => {
  const status = (e as { status?: number }).status;
  return typeof status === 'number' && status < 500 ? (e as Error).message : 'Không kiểm tra được dòng này lúc này — thử lại sau.';
};

/** Dòng nhập có cấu trúc (MCP) → dạng dùng chung với CSV. */
export function rowsFromStructured(
  rows: Array<{ content?: string; account_ids?: number[]; scheduled_at?: string; use_queue?: boolean; media_keys?: string[]; first_comment?: string; youtube_title?: string; utm_campaign?: string }>,
): ImportRowInput[] {
  return rows.map((r, i) => ({
    row: i + 1,
    content: r.content?.trim() || undefined,
    channels: (r.account_ids ?? []).map(String),
    scheduled_at: r.scheduled_at?.trim() || undefined,
    use_queue: r.use_queue === true ? true : undefined,
    media: (r.media_keys ?? []).map((k) => k.trim()).filter(Boolean),
    first_comment: r.first_comment?.trim() || undefined,
    youtube_title: r.youtube_title?.trim() || undefined,
    utm_campaign: r.utm_campaign?.trim() || undefined,
  }));
}

/** Nhập nhiều bài từ CSV / danh sách dòng: kiểm từng dòng (không ném), rồi tạo nháp hoặc bài hẹn giờ từng dòng độc lập. */
@Injectable()
export class SocialImportService {
  private readonly logger = new Logger(SocialImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly posts: SocialPostsService,
    private readonly drafts: SocialDraftsService,
    @Optional() private readonly queue?: SocialQueueService,
  ) {}

  /** Kiểm CSV, không ghi gì. */
  async plan(user: AuthUser, csv: string, mode: ImportMode): Promise<ImportPlan> {
    const parsed = parseCsv(csv);
    const { plan } = await this.planRows(user, parsed.rows, mode);
    return parsed.unknown_columns.length ? { ...plan, unknown_columns: parsed.unknown_columns } : plan;
  }

  /** Nhập CSV: kiểm lại, khác bản người dùng đã xem (`planHash`) ⇒ 409. */
  async importCsv(user: AuthUser, csv: string, mode: ImportMode, planHash: string): Promise<ImportResult> {
    return this.importRows(user, parseCsv(csv).rows, mode, planHash, 'csv');
  }

  async importRows(user: AuthUser, rows: ImportRowInput[], mode: ImportMode, planHash: string, source: 'csv' | 'mcp'): Promise<ImportResult> {
    const { plan, items } = await this.planRows(user, rows, mode);
    if (typeof planHash !== 'string' || plan.plan_hash !== planHash) {
      throw new ConflictException('Dữ liệu đã đổi so với bản đã kiểm tra (dòng, kênh, tệp hoặc trạng thái) — bấm "Kiểm tra" lại rồi nhập.');
    }
    const out: ImportResult = { mode, created: [], skipped: [] };
    // Từng dòng độc lập, theo thứ tự: một dòng hỏng không kéo theo dòng khác.
    for (const it of items) {
      const row = it.plan.row;
      if (!it.plan.ok) {
        out.skipped.push({ row, errors: it.plan.errors });
        continue;
      }
      try {
        // Khoá chống lặp theo (lượt kiểm tra + dòng): gửi lại cùng lượt nhập (timeout, hai tab) không tạo bài lần hai.
        const dedupe = `${source}-import:${plan.plan_hash.slice(0, 16)}:${row}`;
        if (mode === 'drafts') {
          const d = await this.drafts.create(user, it.draft!, source, dedupe);
          out.created.push({ row, id: d.id });
        } else {
          const at = it.post!.scheduled_at ? Date.parse(it.post!.scheduled_at) : NaN;
          // Không bao giờ để `create` đăng ngay vì giờ hẹn đã trôi qua trong lúc nhập.
          if (Number.isNaN(at) || at - Date.now() < IMPORT_MIN_LEAD_MS) throw new BadRequestException('Giờ hẹn đã tới trong lúc nhập — kiểm tra lại với giờ mới.');
          const p = await this.posts.create(user, { ...it.post!, source }, { dedupeSource: dedupe });
          out.created.push({ row, id: p.id });
        }
      } catch (e) {
        this.logger.warn(`Nhập dòng ${row}: ${(e as Error).message}`);
        out.skipped.push({ row, errors: [rowMessage(e)] });
      }
    }
    return out;
  }

  /** Kiểm toàn bộ các dòng (preview-style: gom lỗi theo dòng) + băm. Không ghi gì, không giữ khung hàng đợi. */
  async planRows(user: AuthUser, rows: ImportRowInput[], mode: ImportMode): Promise<{ plan: ImportPlan; items: Item[] }> {
    if (!isImportMode(mode)) throw new BadRequestException('mode phải là "drafts" hoặc "schedule".');
    if (!Array.isArray(rows) || rows.length === 0) throw new BadRequestException('Chưa có dòng nào để nhập.');
    if (rows.length > IMPORT_MAX_ROWS) throw new BadRequestException(`Tối đa ${IMPORT_MAX_ROWS} dòng mỗi lần nhập.`);
    const now = Date.now();

    const accounts = await this.prisma.socialAccount.findMany({ where: { status: { not: 'disabled' } } });
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const byName = new Map<string, typeof accounts>();
    const byLower = new Map<string, typeof accounts>();
    for (const a of accounts) {
      byName.set(a.name, [...(byName.get(a.name) ?? []), a]);
      const l = a.name.toLowerCase();
      byLower.set(l, [...(byLower.get(l) ?? []), a]);
    }

    // Tệp: khoá trước, rồi tên gốc trong thư viện (nhiều tệp trùng tên ⇒ lấy tệp mới nhất + cảnh báo).
    const tokens = [...new Set(rows.flatMap((r) => r.media))];
    const assets = tokens.length ? await this.prisma.socialMediaAsset.findMany({ where: { hidden_at: null, OR: [{ key: { in: tokens } }, { name: { in: tokens } }] }, orderBy: { id: 'desc' }, select: { key: true, name: true } }) : [];
    const keys = new Set(assets.map((a) => a.key));
    const byAssetName = new Map<string, string[]>();
    for (const a of assets) byAssetName.set(a.name, [...(byAssetName.get(a.name) ?? []), a.key]);

    const items: Item[] = rows.map((r) => {
      const errors: string[] = [];
      const warnings: string[] = [];
      const content = (r.content ?? '').trim();
      const chosen: typeof accounts = [];
      for (const tok of r.channels) {
        const id = /^\d+$/.test(tok) ? Number(tok) : undefined;
        let a = id !== undefined ? byId.get(id) : undefined;
        // Số vừa là id một kênh vừa là tên kênh khác ⇒ không đoán.
        if (a && (byName.get(tok) ?? []).some((x) => x.id !== a!.id)) {
          errors.push(`"${tok}" vừa là id kênh vừa là tên một kênh khác — ghi rõ tên hoặc id.`);
          continue;
        }
        if (!a) {
          const exact = byName.get(tok) ?? [];
          const loose = exact.length ? exact : (byLower.get(tok.toLowerCase()) ?? []);
          if (loose.length > 1) {
            errors.push(`Tên kênh "${tok}" trùng nhiều kênh — dùng id kênh.`);
            continue;
          }
          a = loose[0];
        }
        if (!a) {
          errors.push(`Không tìm thấy kênh "${tok.slice(0, 80)}".`);
          continue;
        }
        if (chosen.some((c) => c.id === a!.id)) warnings.push(`Kênh "${a.name}" ghi nhiều lần — chỉ tính một.`);
        else chosen.push(a);
      }
      if (chosen.length > MAX_TARGETS) errors.push(`Tối đa ${MAX_TARGETS} kênh mỗi bài.`);
      if (mode === 'schedule' && chosen.length === 0 && r.channels.length === 0) errors.push('Cần ít nhất một kênh.');
      if (mode === 'drafts') for (const a of chosen) if (a.status !== 'active') warnings.push(`Kênh "${a.name}" cần liên kết lại trước khi đăng.`);

      // Giờ đăng.
      let at: Date | null = null;
      const queue = r.use_queue === true;
      if (queue && r.scheduled_at) errors.push("Chỉ chọn một: giờ cụ thể hoặc 'hàng đợi'.");
      else if (r.scheduled_at) {
        try {
          at = parseVnTime(r.scheduled_at);
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
      if (at) {
        const ahead = at.getTime() - now;
        if (mode === 'schedule') {
          if (ahead <= MINUTE) errors.push('Giờ hẹn phải sau bây giờ ít nhất 1 phút.');
          else if (ahead > MAX_SCHEDULE_AHEAD_MS) errors.push('Chỉ hẹn trước tối đa 90 ngày.');
        } else if (ahead < 0) warnings.push('Giờ hẹn đã qua — sửa lại trước khi đăng nháp.');
        else if (ahead > MAX_SCHEDULE_AHEAD_MS) warnings.push('Giờ hẹn quá 90 ngày — sửa lại trước khi đăng nháp.');
      }
      if (mode === 'schedule' && !at && !queue) errors.push("Cần giờ đăng hoặc 'hàng đợi'.");

      // Tệp.
      const mediaKeys: string[] = [];
      for (const tok of r.media) {
        if (keys.has(tok)) mediaKeys.push(tok);
        else if (byAssetName.has(tok)) {
          const list = byAssetName.get(tok)!;
          mediaKeys.push(list[0]);
          if (list.length > 1) warnings.push(`Có ${list.length} tệp tên "${tok}" — dùng tệp mới nhất.`);
        } else if (/^social\//.test(tok)) mediaKeys.push(tok);
        else errors.push(`Không thấy tệp "${tok.slice(0, 80)}" trong thư viện (khoá hoặc tên tệp gốc).`);
      }
      const media = [...new Set(mediaKeys)];
      if (media.length > MAX_MEDIA_PER_POST) errors.push(`Tối đa ${MAX_MEDIA_PER_POST} tệp mỗi bài.`);
      if (!content && media.length === 0 && r.media.length === 0) errors.push('Cần nội dung hoặc ảnh/video.');

      // UTM.
      let utm: UtmInput | undefined;
      if (r.utm_campaign) {
        try {
          utm = normalizeUtm({ campaign: r.utm_campaign }) ?? undefined;
        } catch (e) {
          errors.push((e as Error).message);
        }
      }

      // Tuỳ chọn riêng từng mạng.
      if (r.first_comment && !chosen.some((a) => a.network === 'facebook')) warnings.push('Không có kênh Facebook — bỏ qua bình luận đầu.');
      if (r.youtube_title && !chosen.some((a) => a.network === 'youtube')) warnings.push('Không có kênh YouTube — bỏ qua tiêu đề YouTube.');
      const targets = chosen.map((a) => {
        const options: Record<string, unknown> = {};
        if (a.network === 'facebook' && r.first_comment) options.first_comment = r.first_comment;
        if (a.network === 'youtube' && r.youtube_title) options.title = r.youtube_title;
        return { account_id: a.id, ...(Object.keys(options).length ? { options } : {}) };
      });

      const plan: RowPlan = {
        row: r.row,
        ok: false,
        errors,
        warnings,
        preview: {
          channels: chosen.map((a) => ({ account_id: a.id, name: a.name, network: a.network })),
          scheduled_at: at ? at.toISOString() : null,
          use_queue: queue,
          content_excerpt: excerpt(content),
        },
      };
      const norm = { row: r.row, content, account_ids: chosen.map((a) => a.id), scheduled_at: at ? at.toISOString() : null, use_queue: queue, media_keys: media, first_comment: r.first_comment ?? null, youtube_title: r.youtube_title ?? null, utm_campaign: utm?.campaign ?? null };
      const base = { content, media_keys: media, targets, ...(utm ? { utm } : {}) };
      const draft: DraftInput = { ...base, ...(queue ? { use_queue: true } : at ? { scheduled_at: at.toISOString() } : {}) };
      const post: CreatePostInput = { ...base, scheduled_at: at ? at.toISOString() : null, source: 'csv' };
      return { plan, norm, queue, ...(mode === 'drafts' ? { draft } : { post }) };
    });

    // Hàng đợi (chỉ bài hẹn): xin MỘT lần đủ số khung cho mọi dòng hợp lệ, gán theo thứ tự dòng ⇒ hai dòng không bao giờ chung khung.
    if (mode === 'schedule') {
      const wanting = items.filter((i) => i.queue && i.plan.errors.length === 0);
      if (wanting.length) {
        const slots = (await this.queue?.nextFree(wanting.length)) ?? [];
        wanting.forEach((it, n) => {
          const slot = slots[n];
          if (!slot) it.plan.errors.push(slots.length === 0 ? NO_QUEUE_SLOTS : 'Không đủ khung trống hàng đợi cho dòng này.');
          else {
            it.post!.scheduled_at = slot.toISOString();
            it.plan.preview.scheduled_at = slot.toISOString();
          }
        });
      }
    }

    // Kiểm đầy đủ như lúc tạo (tuần tự, tránh dồn tải kho tệp).
    for (const it of items) {
      if (it.plan.errors.length === 0) {
        try {
          if (mode === 'drafts') await this.drafts.check(user, it.draft!);
          else {
            const v = await this.posts.validate(user, it.post!);
            if (!v.scheduledAt) throw new BadRequestException('Giờ hẹn đã qua — chọn giờ trong tương lai.');
          }
        } catch (e) {
          it.plan.errors.push(rowMessage(e));
        }
      }
      it.plan.ok = it.plan.errors.length === 0;
      (it.norm as Record<string, unknown>).ok = it.plan.ok;
    }

    const planRows = items.map((i) => i.plan);
    // Băm cả khung hàng đợi đã gán: khung đổi (bị chiếm / đã qua) ⇒ mã khác ⇒ nhập bị từ chối, người dùng kiểm lại thấy giờ mới.
    const hash = createHash('sha256').update(JSON.stringify({ mode, rows: items.map((i) => (i.queue ? { ...i.norm, slot: i.post?.scheduled_at ?? null } : i.norm)) })).digest('hex');
    const ok = planRows.filter((p) => p.ok).length;
    return { plan: { mode, plan_hash: hash, total: planRows.length, ok_count: ok, error_count: planRows.length - ok, rows: planRows }, items };
  }
}
