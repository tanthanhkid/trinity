import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@trinity/prisma';
import type { AuthUser } from '@trinity/rbac-nest';
import { Prisma, type SocialDraft } from '@prisma/client';
import { MAX_MEDIA_PER_POST } from './social.config';
import { normalizeUtm, type UtmInput } from './social-utm';
import { ALREADY_CREATED, SocialPostsService, type CreatePostInput, type CreateTargetInput } from './social-posts.service';

const MAX_DRAFT_CONTENT = 63_206;
const MAX_DRAFT_TARGETS = 20;
/** post_id tạm trong lúc đang đăng (không phải id bài thật). */
const PUBLISHING = -1;
/** Giữ chỗ lâu hơn thế coi như kẹt (tiến trình chết giữa chừng) ⇒ nháp mở lại. */
const STALE_CLAIM_MS = 10 * 60_000;
const CHANGED = 'Nháp đã được sửa sau khi xem trước — xem lại nháp rồi đăng lại.';

export interface DraftMedia {
  key: string;
  type: 'image' | 'video';
  content_type: string;
  size: number;
  name?: string;
}

/** Nháp có thể thiếu mọi thứ; chỉ kiểm hình dạng + kênh/tệp có thật. Kiểm đầy đủ (giờ hẹn, giới hạn từng mạng) chỉ khi đăng. */
export interface DraftInput {
  title?: string | null;
  content?: string;
  /** Tệp kèm tên (web). Khoá chưa có trong nháp được kiểm với thư viện. */
  media?: Array<{ key: string; name?: string }>;
  /** Chỉ khoá (MCP) — thay cho `media`. */
  media_keys?: string[];
  targets?: CreateTargetInput[];
  scheduled_at?: string | null;
  /** Đăng vào khung trống gần nhất của hàng đợi (bỏ giờ cụ thể). */
  use_queue?: boolean;
  /** Gắn UTM khi đăng: ghi vào `options.utm` của từng kênh trong nháp. null = bỏ. */
  utm?: UtmInput | null;
  ui?: Record<string, unknown> | null;
}

export type DraftTarget = { account_id: number; caption?: string | null; options?: Record<string, unknown> };

@Injectable()
export class SocialDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posts: SocialPostsService,
  ) {}

  /** Nháp còn mở: chưa đăng, hoặc giữ chỗ đăng đã kẹt quá STALE_CLAIM_MS. */
  private open(): Prisma.SocialDraftWhereInput {
    return { OR: [{ post_id: null }, { post_id: PUBLISHING, publishing_at: { lt: new Date(Date.now() - STALE_CLAIM_MS) } }] };
  }

  /** Bài đăng không chia theo người (cả công ty thấy chung) ⇒ nháp cũng chung. Nháp đã đăng thì ẩn. */
  async list() {
    const data = await this.prisma.socialDraft.findMany({ where: this.open(), orderBy: { updated_at: 'desc' }, take: 100 });
    return { data };
  }

  async get(id: number): Promise<SocialDraft> {
    const d = await this.prisma.socialDraft.findFirst({ where: { id, ...this.open() } });
    if (!d) throw new NotFoundException('Không tìm thấy bài nháp');
    return d;
  }

  /** Kiểm đầu vào như lúc lưu nhưng KHÔNG ghi (nhập CSV: xem trước từng dòng nháp). */
  async check(user: AuthUser, input: DraftInput): Promise<void> {
    await this.build(user, input, []);
  }

  /** `dedupeSource` như ở SocialPostsService.create: khoá duy nhất của lần tạo; đã có nháp mang khoá này ⇒ 409. */
  async create(user: AuthUser, input: DraftInput, source = 'web', dedupeSource?: string): Promise<SocialDraft> {
    const data = await this.build(user, input, []);
    if (dedupeSource) {
      return this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${dedupeSource}))`;
        if (await tx.socialDraft.findFirst({ where: { source: dedupeSource }, select: { id: true } })) throw new ConflictException(ALREADY_CREATED);
        return tx.socialDraft.create({ data: this.createData(user, data, dedupeSource) });
      });
    }
    return this.prisma.socialDraft.create({ data: this.createData(user, data, source) });
  }

  private createData(user: AuthUser, data: Awaited<ReturnType<SocialDraftsService['build']>>, source: string): Prisma.SocialDraftUncheckedCreateInput {
    return {
      title: data.title ?? null,
      content: data.content ?? '',
      media: (data.media ?? []) as unknown as Prisma.InputJsonValue,
      targets: (data.targets ?? []) as unknown as Prisma.InputJsonValue,
      scheduled_at: data.scheduled_at ?? null,
      use_queue: data.use_queue ?? false,
      ui: data.ui ? (data.ui as Prisma.InputJsonValue) : undefined,
      source: source.slice(0, 80),
      created_by: user.userId,
    };
  }

  /** Chỉ trường có gửi mới đổi. Nháp đã đăng thì không sửa nữa. */
  async update(user: AuthUser, id: number, input: DraftInput): Promise<SocialDraft> {
    const cur = await this.prisma.socialDraft.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException('Không tìm thấy bài nháp');
    const data = await this.build(user, input, (cur.media as unknown as DraftMedia[]) ?? [], (cur.targets as unknown as DraftTarget[]) ?? []);
    // Ghi có điều kiện "nháp còn mở" (không đè lượt đang đăng); giữ chỗ đã kẹt thì sửa xong nháp mở lại hẳn.
    const patch: Prisma.SocialDraftUpdateManyMutationInput = { post_id: null, publishing_at: null };
    if (data.title !== undefined) patch.title = data.title;
    if (data.content !== undefined) patch.content = data.content;
    if (data.media !== undefined) patch.media = data.media as unknown as Prisma.InputJsonValue;
    if (data.targets !== undefined) patch.targets = data.targets as unknown as Prisma.InputJsonValue;
    if (data.scheduled_at !== undefined) patch.scheduled_at = data.scheduled_at;
    if (data.use_queue !== undefined) patch.use_queue = data.use_queue;
    if (input.ui !== undefined) patch.ui = input.ui ? (input.ui as Prisma.InputJsonValue) : Prisma.DbNull;
    // Sửa nội dung / kênh / tệp / giờ mà không kèm trạng thái màn soạn (vd trợ lý AI sửa) ⇒ bỏ trạng thái cũ, màn soạn dựng lại từ dữ liệu mới.
    else if ([data.content, data.media, data.targets, data.scheduled_at, data.use_queue].some((x) => x !== undefined)) patch.ui = Prisma.DbNull;
    const n = await this.prisma.socialDraft.updateMany({ where: { id, ...this.open() }, data: patch });
    if (n.count === 0) throw new ConflictException('Nháp này đang được đăng hoặc đã đăng, không sửa được nữa.');
    return (await this.prisma.socialDraft.findUnique({ where: { id } }))!;
  }

  async remove(id: number): Promise<void> {
    const r = await this.prisma.socialDraft.deleteMany({ where: { id, ...this.open() } });
    if (r.count === 0) throw new NotFoundException('Không tìm thấy bài nháp');
  }

  /** Dựng đầu vào đăng bài từ nháp (không ghi gì) — dùng cho đăng thật và bản xem trước của MCP. */
  toPostInput(d: SocialDraft, overrides: { scheduled_at?: string | null; use_queue?: boolean } = {}, source = 'web'): CreatePostInput {
    const media = (d.media as unknown as DraftMedia[]) ?? [];
    // Ghi đè lúc đăng thắng giá trị lưu trong nháp; không ghi đè thì theo nháp (giờ cụ thể hoặc cờ hàng đợi).
    const queue = overrides.use_queue ? true : overrides.scheduled_at !== undefined ? false : d.use_queue;
    const scheduled = overrides.scheduled_at !== undefined ? overrides.scheduled_at : d.scheduled_at ? d.scheduled_at.toISOString() : null;
    return {
      content: d.content,
      media_keys: media.map((m) => m.key),
      targets: ((d.targets as unknown as DraftTarget[]) ?? []).map((t) => ({ account_id: t.account_id, caption: t.caption ?? null, options: t.options ?? {} })),
      scheduled_at: queue ? null : scheduled,
      use_queue: queue ? true : undefined,
      source,
    };
  }

  /**
   * Đăng nháp = tạo bài thật (kiểm đầy đủ ở `SocialPostsService.create`).
   * - Giữ chỗ (post_id = PUBLISHING) có điều kiện theo ĐÚNG bản vừa đọc (updated_at) ⇒ hai lượt đăng cùng lúc không tạo hai bài,
   *   và nội dung đăng là nội dung đã đọc. Giữ chỗ / trả chỗ không đổi updated_at (lượt thử lại với cùng phiên bản vẫn hợp lệ).
   * - Gắn post_id thật NGAY TRONG transaction tạo bài ⇒ bài có thì nháp đã gắn; lỗi thì chỉ trả chỗ khi bài chưa được tạo.
   * - Giữ chỗ quá STALE_CLAIM_MS (tiến trình chết giữa chừng) thì nháp mở lại được.
   * `expectUpdatedAt`: nháp phải còn đúng bản người dùng đã xem (sửa sau đó ⇒ 409).
   */
  async publish(user: AuthUser, id: number, overrides: { scheduled_at?: string | null; use_queue?: boolean } = {}, source = 'web', expectUpdatedAt?: Date) {
    const d = await this.get(id);
    if (expectUpdatedAt && d.updated_at.getTime() !== expectUpdatedAt.getTime()) throw new ConflictException(CHANGED);
    const keep = { updated_at: d.updated_at };
    const claimed = await this.prisma.socialDraft.updateMany({
      where: { id, post_id: d.post_id, updated_at: d.updated_at },
      data: { post_id: PUBLISHING, publishing_at: new Date(), ...keep },
    });
    if (claimed.count === 0) throw new ConflictException(expectUpdatedAt ? CHANGED : 'Nháp đang được đăng hoặc vừa được sửa — mở lại nháp rồi thử lại.');
    try {
      return await this.posts.create(user, this.toPostInput(d, overrides, source), {
        inTx: async (tx, postId) => {
          const n = await tx.socialDraft.updateMany({ where: { id, post_id: PUBLISHING }, data: { post_id: postId, publishing_at: null, ...keep } });
          if (n.count !== 1) throw new ConflictException('Nháp đang được đăng hoặc đã đăng.');
        },
      });
    } catch (err) {
      // Chỉ trả chỗ khi bài CHƯA được tạo (transaction tạo bài đã gắn post_id thật thì điều kiện PUBLISHING không còn khớp).
      await this.prisma.socialDraft.updateMany({ where: { id, post_id: PUBLISHING }, data: { post_id: null, publishing_at: null, ...keep } }).catch(() => undefined);
      throw err;
    }
  }

  /** Kiểm nhẹ → các trường sẽ ghi (undefined = không đổi). `existing` = tệp đang có trong nháp, khỏi kiểm lại. */
  private async build(user: AuthUser, input: DraftInput, existing: DraftMedia[], curTargets: DraftTarget[] = []) {
    const out: { title?: string | null; content?: string; media?: DraftMedia[]; targets?: DraftTarget[]; scheduled_at?: Date | null; use_queue?: boolean; ui?: Record<string, unknown> | null } = {};
    if (input.use_queue !== undefined) {
      out.use_queue = Boolean(input.use_queue);
      if (out.use_queue && input.scheduled_at) throw new BadRequestException('Chỉ chọn một: vào hàng đợi hoặc giờ hẹn cụ thể.');
      if (out.use_queue) out.scheduled_at = null;
    }
    if (input.title !== undefined) out.title = input.title?.trim() ? input.title.trim().slice(0, 120) : null;
    if (input.content !== undefined) {
      if (typeof input.content !== 'string' || input.content.length > MAX_DRAFT_CONTENT) throw new BadRequestException(`Nội dung tối đa ${MAX_DRAFT_CONTENT} ký tự.`);
      out.content = input.content;
    }
    if (input.ui !== undefined) out.ui = input.ui;
    if (input.scheduled_at !== undefined) {
      if (input.scheduled_at === null || input.scheduled_at === '') out.scheduled_at = null;
      else {
        const t = new Date(input.scheduled_at);
        if (Number.isNaN(t.getTime())) throw new BadRequestException('scheduled_at không đúng định dạng ISO 8601.');
        out.scheduled_at = t;
        if (input.use_queue === undefined) out.use_queue = false;
      }
    }
    if (input.targets !== undefined) {
      if (input.targets.length > MAX_DRAFT_TARGETS) throw new BadRequestException(`Tối đa ${MAX_DRAFT_TARGETS} kênh mỗi bài.`);
      const ids = input.targets.map((t) => t.account_id);
      if (new Set(ids).size !== ids.length) throw new BadRequestException('Mỗi kênh chỉ chọn một lần.');
      const found = await this.prisma.socialAccount.findMany({ where: { id: { in: ids }, status: { not: 'disabled' } }, select: { id: true } });
      const have = new Set(found.map((a) => a.id));
      for (const id of ids) if (!have.has(id)) throw new BadRequestException(`Không tìm thấy kênh #${id}.`);
      out.targets = input.targets.map((t) => {
        const o: DraftTarget = { account_id: t.account_id };
        if (typeof t.caption === 'string' && t.caption.trim()) o.caption = t.caption;
        if (t.options && typeof t.options === 'object' && !Array.isArray(t.options) && Object.keys(t.options).length > 0) o.options = t.options;
        return o;
      });
    }
    // Đổi danh sách kênh mà không gửi utm: kênh mới gắn theo UTM của các kênh đang có.
    if (input.utm === undefined && out.targets) {
      const curUtm = curTargets.map((t) => t.options?.utm).find(Boolean);
      if (curUtm) out.targets = out.targets.map((t) => (t.options?.utm ? t : { ...t, options: { ...(t.options ?? {}), utm: curUtm } }));
    }
    if (input.utm !== undefined) {
      let utm: UtmInput | null;
      try {
        utm = normalizeUtm(input.utm);
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
      // UTM nằm trong tuỳ chọn từng kênh ⇒ đăng nháp (toPostInput) giữ nguyên, không cần cột mới. Không gửi kênh thì áp lên kênh đang có.
      out.targets = (out.targets ?? curTargets).map((t) => {
        const { utm: _old, ...rest } = t.options ?? {};
        const options = utm ? { ...rest, utm } : rest;
        const { options: _o, ...head } = t;
        return Object.keys(options).length > 0 ? { ...head, options } : head;
      });
    }
    const list = input.media ?? input.media_keys?.map((key) => ({ key }));
    if (list !== undefined) {
      const keys = [...new Set(list.map((m) => m.key.trim()).filter(Boolean))];
      if (keys.length > MAX_MEDIA_PER_POST) throw new BadRequestException(`Tối đa ${MAX_MEDIA_PER_POST} tệp mỗi bài.`);
      const known = new Map(existing.map((m) => [m.key, m]));
      const fresh = keys.filter((k) => !known.has(k));
      const resolved = new Map((fresh.length ? await this.posts.media.resolve(user, fresh) : []).map((m) => [m.key, m as DraftMedia]));
      const names = new Map(list.map((m) => [m.key.trim(), (m as { name?: string }).name]));
      out.media = keys.map((k) => {
        const m = { ...(known.get(k) ?? resolved.get(k)!) };
        const name = names.get(k) ?? m.name;
        if (name) m.name = String(name).slice(0, 200);
        return m;
      });
    }
    return out;
  }
}
