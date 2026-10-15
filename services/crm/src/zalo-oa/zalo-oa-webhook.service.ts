import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ZaloOaApiClient } from './zalo-oa-api.client';
import { ZaloOaContactLinker } from './zalo-oa-contact-linker.service';
import { ZaloOaFeatureService } from './zalo-oa-feature.service';
import { verifyZaloSignature } from './zalo-oa-signature';
import { ZaloOaThreadsService } from './zalo-oa-threads.service';
import { ZaloOaTokenService } from './zalo-oa-token.service';
import { zaloOaConfig } from './zalo-oa.config';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null);

/** Sự kiện khách gửi (OA nhận): user_send_text / _image / _link / _location / _sticker / _gif / _audio / _video / _file. */
const INBOUND_RE = /^user_send_/;
/** Tin do chính OA gửi đi từ app/web Zalo (đồng bộ vào hộp thư): oa_send_text / oa_send_image ... */
const OUTBOUND_RE = /^oa_send_/;

/**
 * Webhook Zalo OA. Luôn kiểm chữ ký TRƯỚC (sai/thiếu ⇒ 401, không phân biệt lý do). Sau đó trả 200 cho mọi sự kiện
 * (kể cả loại chưa hỗ trợ) để Zalo không gửi lại; lỗi hệ thống (DB) cho nổ 500 để Zalo gửi lại — tin được khử trùng theo msg_id.
 * Cờ tổ chức `zalo_oa` tắt ⇒ nhận 200 nhưng bỏ qua.
 */
@Injectable()
export class ZaloOaWebhookService {
  private readonly logger = new Logger(ZaloOaWebhookService.name);

  constructor(
    private readonly threads: ZaloOaThreadsService,
    private readonly linker: ZaloOaContactLinker,
    private readonly tokens: ZaloOaTokenService,
    private readonly api: ZaloOaApiClient,
    private readonly feature: ZaloOaFeatureService,
  ) {}

  async receive(rawBody: Buffer | undefined, signature: string | undefined): Promise<{ ok: true; handled: boolean }> {
    const cfg = zaloOaConfig();
    if (!verifyZaloSignature({ appId: cfg.appId, secret: cfg.webhookSecret, rawBody, header: signature })) {
      throw new UnauthorizedException('Chữ ký không hợp lệ');
    }
    if (!(await this.feature.isEnabled())) return { ok: true, handled: false };
    const ev = obj(JSON.parse((rawBody as Buffer).toString('utf8')));
    const name = str(ev.event_name) ?? '';
    if (INBOUND_RE.test(name)) return { ok: true, handled: await this.onMessage(ev, 'in') };
    if (OUTBOUND_RE.test(name)) return { ok: true, handled: await this.onMessage(ev, 'out') };
    if (name === 'follow') return { ok: true, handled: await this.onFollow(ev) };
    return { ok: true, handled: false };
  }

  private async onFollow(ev: Obj): Promise<boolean> {
    const userId = str(obj(ev.follower).id) ?? str(obj(ev.sender).id);
    const oaId = str(obj(ev.oa).id) ?? str(obj(ev.recipient).id);
    if (!userId || !oaId) return false;
    const t = await this.threads.upsertThread(oaId, userId);
    await this.enrich(t.id, userId, oaId);
    return true;
  }

  private async onMessage(ev: Obj, dir: 'in' | 'out'): Promise<boolean> {
    const sender = str(obj(ev.sender).id);
    const recipient = str(obj(ev.recipient).id);
    const userId = dir === 'in' ? sender : recipient;
    const oaId = dir === 'in' ? recipient : sender;
    const msg = obj(ev.message);
    if (!userId || !oaId) return false;
    const existed = await this.threads.upsertThread(oaId, userId);
    const isNew = existed.last_message_at === null && existed.contact_id === null && existed.display_name === null;
    const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
    const text = str(msg.text);
    const at = new Date(Number(ev.timestamp));
    const row = await this.threads.record({
      threadId: existed.id, direction: dir, kind: text !== null ? 'text' : 'attachment', msgId: str(msg.msg_id), text,
      payload: (attachments.length ? { attachments } : {}) as Prisma.InputJsonValue,
      status: dir === 'in' ? 'received' : 'sent', at: Number.isFinite(at.getTime()) ? at : undefined,
    });
    if (row && isNew) await this.enrich(existed.id, userId, oaId);
    return row !== null;
  }

  /** Lấy hồ sơ (tên/ảnh/SĐT nếu khách chia sẻ) và ghép/tạo khách. Best-effort: lỗi không làm hỏng việc nhận tin. */
  private async enrich(threadId: number, userId: string, oaId: string): Promise<void> {
    try {
      const { token, connectedBy } = await this.tokens.getAccessToken();
      const p = await this.api.getProfile(token, userId);
      const contactId = await this.linker.findOrCreate({ zaloUserId: userId, phone: p.phone, name: p.display_name, ownerUserId: connectedBy });
      await this.threads.updateProfile(threadId, { name: p.display_name, avatar: p.avatar, phone: p.phone }, contactId);
    } catch (err) {
      this.logger.warn(`Không lấy được hồ sơ Zalo user (oa=${oaId}): ${(err as Error).message}`);
    }
  }
}
