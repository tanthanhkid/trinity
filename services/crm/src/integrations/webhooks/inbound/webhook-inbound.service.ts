import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
  BadRequestException,
} from '@nestjs/common';
import { IntegrationAuditService, PrismaService, integrationFlags } from '@trinity/prisma';
import type { Prisma, WebhookInboundSource } from '@prisma/client';
import { FixedWindowLimiter } from '../../../common/helpers/fixed-window-limiter';
import { PublicApiService } from '../../../public-api/public-api.service';
import { decryptSecret, IntegrationsKeyError, loadSecretKey } from '../secret-crypto';
import { verifySignatureHeader } from '../signature';
import { hashInboundToken, INBOUND_TOKEN_RE } from './inbound-token';
import { MAX_BODY_BYTES, parseInboundPayload, type ParsedInbound } from './inbound-payload';

export interface InboundRequest {
  rawBody: Buffer | undefined;
  body: unknown;
  signature: string | undefined;
}
/**
 * Phản hồi CÔNG KHAI luôn là `200 { status: "accepted", contact_id: null }` — số mới, số đã có, gửi lại đều giống hệt,
 * nên người ngoài không dò được SĐT nào đã là khách. `outcome`/`contactId` chỉ để ghi nhật ký nội bộ.
 */
export interface InboundResult {
  httpStatus: 200;
  body: { status: 'accepted'; contact_id: null };
  outcome: 'created' | 'duplicate' | 'replayed';
  contactId: number | null;
}

/** 429 kèm cờ "lần đầu vượt hạn mức trong cửa sổ" (để chỉ ghi nhật ký một lần). */
class RateLimitedError extends HttpException {
  constructor(
    retryAfter: number,
    readonly firstInWindow: boolean,
  ) {
    super({ statusCode: 429, message: 'Quá nhiều request, thử lại sau.', retryAfter }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/** `foreign` = khách thuộc người KHÁC sale nhận của nguồn ⇒ KHÔNG lộ `contact_id` ra ngoài. */
type Outcome = { kind: 'created' | 'duplicate' | 'replayed'; contactId: number | null; foreign: boolean };

/**
 * Webhook VÀO: nhận khách từ nguồn ngoài. Thứ tự kiểm CỐ Ý: cờ → định dạng token → tra token (sai/tắt ⇒ 404,
 * không phân biệt) → rate limit theo nguồn → chữ ký (nếu nguồn có secret) → kiểm payload → người nhận còn hoạt động → ghi.
 * Mọi request đã nhận diện được nguồn đều ghi `integration_audit_logs` (channel webhook_in) — KHÔNG ghi body/SĐT.
 */
@Injectable()
export class WebhookInboundService {
  private readonly logger = new Logger(WebhookInboundService.name);
  private readonly limiter = new FixedWindowLimiter(100, 60_000);
  /** Lần xác thực (chữ ký) THẤT BẠI theo token: chặn dò/gây ồn, độc lập với hạn mức request hợp lệ. */
  private readonly failLimiter = new FixedWindowLimiter(30, 60_000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly publicApi: PublicApiService,
    private readonly audit: IntegrationAuditService,
  ) {}

  async receive(token: string, req: InboundRequest): Promise<InboundResult> {
    if (!integrationFlags.webhooksEnabled() || !INBOUND_TOKEN_RE.test(token)) throw new NotFoundException();
    const src = await this.prisma.webhookInboundSource.findUnique({ where: { token_hash: hashInboundToken(token) } });
    if (!src || !src.is_active) throw new NotFoundException();
    const started = Date.now();
    try {
      const out = await this.process(src, req);
      await this.record(src, started, 'ok', out.httpStatus, { result: out.outcome }, out.contactId);
      return out;
    } catch (err) {
      const status = err instanceof HttpException ? err.getStatus() : 500;
      const denied = status === HttpStatus.UNAUTHORIZED || status === HttpStatus.TOO_MANY_REQUESTS;
      // Bị chặn hạn mức: chỉ ghi nhật ký lần ĐẦU mỗi cửa sổ (không để kẻ gửi dồn khuếch đại ghi DB).
      if (!(err instanceof RateLimitedError) || err.firstInWindow) {
        await this.record(src, started, denied ? 'denied' : 'error', status, { reason: this.reason(err) });
      }
      if (!(err instanceof HttpException)) this.logger.error(`Webhook vào source=${src.id}: lỗi ${(err as Error)?.message}`);
      throw err;
    }
  }

  private reason(err: unknown): string {
    if (!(err instanceof HttpException)) return 'internal_error';
    const r = err.getResponse();
    return (typeof r === 'string' ? r : ((r as { message?: unknown }).message ?? '')).toString().slice(0, 200);
  }

  private async process(src: WebhookInboundSource, req: InboundRequest): Promise<InboundResult> {
    if (!req.rawBody || req.rawBody.length === 0) throw new BadRequestException('Body phải là JSON (Content-Type: application/json)');
    if (req.rawBody.length > MAX_BODY_BYTES) throw new PayloadTooLargeException(`Body tối đa ${MAX_BODY_BYTES} byte`);
    // Chữ ký TRƯỚC hạn mức: người chỉ biết token (không có secret) không tiêu được hạn mức của bên gửi hợp lệ;
    // lần sai chữ ký bị đếm riêng (failLimiter).
    if (src.signing_secret_enc) this.verifySignature(src, req);
    const rl = this.limiter.hit(`tok:${src.token_hash}`);
    if (!rl.allowed) throw new RateLimitedError(rl.retryAfterSec, rl.count === this.limiter.max + 1);
    await this.prisma.webhookInboundSource.update({ where: { id: src.id }, data: { last_received_at: new Date() }, select: { id: true } });

    const parsed = parseInboundPayload(req.body);
    if (!parsed.ok) throw new BadRequestException(parsed.errors.join('; '));
    const owner = await this.loadOwner(src);
    await this.assertSourceUsable(src);
    const out = await this.persist(src, parsed.value, owner);
    return { httpStatus: 200, body: { status: 'accepted', contact_id: null }, outcome: out.kind, contactId: out.contactId };
  }

  /** Thiếu khoá giải mã ⇒ 503 (không thể kiểm chữ ký, KHÔNG được bỏ qua kiểm). Sai chữ ký ⇒ 401 chung chung. */
  private verifySignature(src: WebhookInboundSource, req: InboundRequest): void {
    let secret: string;
    try {
      secret = decryptSecret(src.signing_secret_enc as string, loadSecretKey());
    } catch (err) {
      if (err instanceof IntegrationsKeyError) throw new ServiceUnavailableException('Không kiểm được chữ ký (cấu hình khoá mã hoá của máy chủ)');
      throw err;
    }
    if (!verifySignatureHeader(secret, req.rawBody as Buffer, req.signature)) {
      const f = this.failLimiter.hit(`fail:${src.token_hash}`);
      if (!f.allowed) throw new RateLimitedError(f.retryAfterSec, f.count === this.failLimiter.max + 1);
      throw new UnauthorizedException('Chữ ký không hợp lệ');
    }
  }

  private async loadOwner(src: WebhookInboundSource): Promise<{ id: number; team_id: number | null }> {
    const u = await this.prisma.user.findUnique({ where: { id: src.default_assignee_id }, select: { id: true, status: true, team_id: true, deleted_at: true } });
    if (!u || u.status !== 'active' || u.deleted_at !== null) {
      this.logger.warn(`Webhook vào source=${src.id}: người nhận mặc định ${src.default_assignee_id} không còn hoạt động`);
      throw new UnprocessableEntityException('Người nhận mặc định của nguồn không còn hoạt động');
    }
    return { id: u.id, team_id: u.team_id };
  }

  private async assertSourceUsable(src: WebhookInboundSource): Promise<void> {
    const o = await this.prisma.settingOption.findUnique({ where: { id: src.contact_source_id }, select: { group_key: true, is_active: true } });
    if (!o || o.group_key !== 'contact_source' || !o.is_active) {
      this.logger.warn(`Webhook vào source=${src.id}: nguồn khách ${src.contact_source_id} không còn dùng được`);
      throw new UnprocessableEntityException('Nguồn khách của nguồn webhook không còn dùng được');
    }
  }

  private phoneVariants(local: string): string[] {
    return [local, `84${local.slice(1)}`, `+84${local.slice(1)}`];
  }

  /** 1 transaction: idempotency (UNIQUE) → khoá theo SĐT → dedupe → (tạo khách + outbox | ghi activity). */
  private persist(src: WebhookInboundSource, p: ParsedInbound, owner: { id: number; team_id: number | null }): Promise<Outcome> {
    return this.prisma.$transaction(async (tx): Promise<Outcome> => {
      if (p.external_id) {
        const claimed = await tx.$queryRaw<{ id: bigint }[]>`
          INSERT INTO webhook_inbound_receipts (source_id, external_id) VALUES (${src.id}, ${p.external_id})
          ON CONFLICT (source_id, external_id) DO NOTHING RETURNING id`;
        if (claimed.length === 0) {
          const prev = await tx.webhookInboundReceipt.findUnique({ where: { source_id_external_id: { source_id: src.id, external_id: p.external_id } } });
          const prevContact = prev?.contact_id
            ? await tx.contact.findUnique({ where: { id: prev.contact_id }, select: { assigned_to: true } })
            : null;
          return { kind: 'replayed', contactId: prev?.contact_id ?? null, foreign: prevContact !== null && prevContact.assigned_to !== owner.id };
        }
      }
      // Cùng khoá với `ContactsService.create` (hashtext(phone)) ⇒ tạo tay và webhook vào cùng SĐT cũng tuần tự.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${p.phone}))`;
      const dup = await tx.contact.findFirst({ where: { phone: { in: this.phoneVariants(p.phone) }, deleted_at: null }, orderBy: { id: 'asc' }, select: { id: true, assigned_to: true } });
      let contactId: number;
      if (dup) {
        contactId = dup.id;
      } else {
        const created = await this.publicApi.createContactInTx(
          tx,
          { phone: p.phone, full_name: p.name, source_id: src.contact_source_id, email: p.email, project_id: src.project_id },
          owner,
          'webhook_in',
        );
        contactId = created.id;
      }
      // Khách cũ của người KHÁC: chỉ ghi dấu vết ngắn (không `extra`, ghi chú cắt 500) — nguồn ngoài không gieo nội dung dài vào hồ sơ người khác.
      const foreign = dup !== null && dup.assigned_to !== owner.id;
      await tx.activity.create({ data: this.activity(src, p, contactId, dup !== null, foreign) });
      if (p.external_id) {
        await tx.webhookInboundReceipt.update({ where: { source_id_external_id: { source_id: src.id, external_id: p.external_id } }, data: { contact_id: contactId } });
      }
      return { kind: dup ? 'duplicate' : 'created', contactId, foreign };
    });
  }

  private activity(src: WebhookInboundSource, p: ParsedInbound, contactId: number, duplicate: boolean, foreign: boolean): Prisma.ActivityUncheckedCreateInput {
    const head = duplicate ? `Khách gửi lại từ webhook "${src.name}"` : `Tạo từ webhook "${src.name}"`;
    const label = p.source ? ` (${p.source})` : '';
    const note = p.note ? (foreign ? p.note.slice(0, 500) : p.note) : '';
    const extra = !foreign && p.extra ? { extra: p.extra } : {};
    return {
      contact_id: contactId,
      action: 'note',
      details: { description: `${head}${label}${note ? ` — ${note}` : ''}`, source: 'webhook_in' },
      metadata: { webhook_source_id: src.id, ...(p.external_id ? { external_id: p.external_id } : {}), ...extra } as Prisma.InputJsonObject,
      created_by: null,
    };
  }

  private record(src: WebhookInboundSource, started: number, status: 'ok' | 'denied' | 'error', httpStatus: number, meta: Record<string, unknown>, contactId?: number | null): Promise<void> {
    return this.audit.log({
      channel: 'webhook_in',
      action: 'receive',
      status,
      clientId: `source:${src.id}`,
      userId: null, // tác nhân là hệ thống ngoài, KHÔNG phải sale nhận (tránh đọc nhầm khi điều tra)
      resource: contactId ? 'contact' : 'webhook_source',
      resourceId: contactId ?? src.id,
      httpStatus,
      durationMs: Date.now() - started,
      error: status === 'ok' ? null : String(meta.reason ?? ''),
      metadata: { source_id: src.id, assignee_id: src.default_assignee_id, ...(status === 'ok' ? meta : {}) },
    });
  }
}
