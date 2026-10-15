import { BadRequestException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { IntegrationAuditService, PrismaService } from '@trinity/prisma';
import { ScopeService, type AuthUser } from '@trinity/rbac-nest';
import type { WebhookInboundSource } from '@prisma/client';
import { encryptSecret, generateWebhookSecret, IntegrationsKeyError, loadSecretKey } from '../secret-crypto';
import { generateInboundToken, hashInboundToken, inboundTokenPrefix, INBOUND_PATH_PREFIX } from './inbound-token';
import type { CreateInboundSourceDto, UpdateInboundSourceDto } from './dto-inbound-source';

export const MAX_INBOUND_SOURCES = 50;

/** Phản hồi — KHÔNG có `token_hash`/`signing_secret_enc`. */
export function toSourceView(s: WebhookInboundSource) {
  const { token_hash: _h, signing_secret_enc: enc, ...rest } = s;
  return { ...rest, signed: enc !== null };
}

@Injectable()
export class WebhookInboundSourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: IntegrationAuditService,
  ) {}

  private key(): Buffer {
    try {
      return loadSecretKey();
    } catch (err) {
      if (err instanceof IntegrationsKeyError) throw new ServiceUnavailableException(err.message);
      throw err;
    }
  }

  private async find(id: number): Promise<WebhookInboundSource> {
    const s = await this.prisma.webhookInboundSource.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Không tìm thấy nguồn');
    return s;
  }

  private log(userId: number, action: string, id: number, meta: Record<string, unknown> = {}): Promise<void> {
    return this.audit.log({ channel: 'webhook_in', action, status: 'ok', userId, resource: 'webhook_source', resourceId: id, metadata: meta });
  }

  /** Người nhận phải đang hoạt động VÀ nằm trong phạm vi `contacts.transfer` của người cấu hình (không gán khách cho người ngoài tầm). */
  private async assertAssignable(actor: AuthUser, assigneeId: number): Promise<void> {
    const u = await this.prisma.user.findUnique({ where: { id: assigneeId }, select: { status: true, deleted_at: true } });
    if (!u || u.status !== 'active' || u.deleted_at !== null) throw new BadRequestException('Người nhận không tồn tại hoặc không hoạt động');
    if (assigneeId === actor.userId) return;
    const owners = await this.scope.ownerIds(actor, 'contacts.transfer');
    if (owners === 'all' || (owners !== null && owners.includes(assigneeId))) return;
    throw new ForbiddenException('Không có quyền gán khách cho người này (cần contacts.transfer phủ người nhận)');
  }

  private async assertContactSource(id: number): Promise<void> {
    const o = await this.prisma.settingOption.findUnique({ where: { id }, select: { group_key: true, is_active: true } });
    if (!o || o.group_key !== 'contact_source') throw new BadRequestException('contact_source_id không thuộc nhóm nguồn khách');
    if (!o.is_active) throw new BadRequestException('Nguồn khách đang bị tắt');
  }

  private async assertProject(id: number): Promise<void> {
    if (!(await this.prisma.project.findUnique({ where: { id }, select: { id: true } }))) throw new BadRequestException('project_id không tồn tại');
  }

  async list() {
    const rows = await this.prisma.webhookInboundSource.findMany({ orderBy: { id: 'desc' }, take: MAX_INBOUND_SOURCES + 5 });
    return rows.map(toSourceView);
  }

  async get(id: number) {
    return toSourceView(await this.find(id));
  }

  async create(dto: CreateInboundSourceDto, actor: AuthUser) {
    const key = this.key();
    if ((await this.prisma.webhookInboundSource.count()) >= MAX_INBOUND_SOURCES) {
      throw new BadRequestException(`Tối đa ${MAX_INBOUND_SOURCES} nguồn webhook vào`);
    }
    await this.assertAssignable(actor, dto.default_assignee_id);
    await this.assertContactSource(dto.contact_source_id);
    if (dto.project_id !== undefined) await this.assertProject(dto.project_id);
    const token = generateInboundToken();
    const signing = dto.signed ? generateWebhookSecret() : null;
    const row = await this.prisma.webhookInboundSource.create({
      data: {
        name: dto.name,
        token_hash: hashInboundToken(token),
        token_prefix: inboundTokenPrefix(token),
        signing_secret_enc: signing ? encryptSecret(signing, key) : null,
        default_assignee_id: dto.default_assignee_id,
        contact_source_id: dto.contact_source_id,
        project_id: dto.project_id ?? null,
        created_by: actor.userId,
      },
    });
    await this.log(actor.userId, 'source.created', row.id, { signed: signing !== null });
    return { ...toSourceView(row), token, path: `${INBOUND_PATH_PREFIX}${token}`, ...(signing ? { signing_secret: signing } : {}) };
  }

  async update(id: number, dto: UpdateInboundSourceDto, actor: AuthUser) {
    const cur = await this.find(id);
    const data: Record<string, unknown> = {};
    // Mọi thay đổi trừ "chỉ TẮT nguồn" đều dùng quyền của nguồn (tạo khách thay mặt người nhận) ⇒ người sửa phải với tới người nhận cuối cùng.
    const onlyDisabling =
      dto.is_active === false &&
      dto.name === undefined && dto.default_assignee_id === undefined && dto.contact_source_id === undefined &&
      dto.project_id === undefined && dto.signed === undefined;
    if (!onlyDisabling) await this.assertAssignable(actor, dto.default_assignee_id ?? cur.default_assignee_id);
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.is_active !== undefined) data.is_active = dto.is_active;
    if (dto.default_assignee_id !== undefined && dto.default_assignee_id !== cur.default_assignee_id) {
      data.default_assignee_id = dto.default_assignee_id;
    }
    if (dto.contact_source_id !== undefined && dto.contact_source_id !== cur.contact_source_id) {
      await this.assertContactSource(dto.contact_source_id);
      data.contact_source_id = dto.contact_source_id;
    }
    if (dto.project_id !== undefined) {
      if (dto.project_id !== null) await this.assertProject(dto.project_id);
      data.project_id = dto.project_id;
    }
    let signing: string | null = null;
    if (dto.signed === true) {
      signing = generateWebhookSecret();
      data.signing_secret_enc = encryptSecret(signing, this.key());
    } else if (dto.signed === false) {
      data.signing_secret_enc = null;
    }
    const saved = await this.prisma.webhookInboundSource.update({ where: { id }, data });
    await this.log(actor.userId, 'source.updated', id, { fields: Object.keys(data) });
    return { ...toSourceView(saved), ...(signing ? { signing_secret: signing } : {}) };
  }

  async rotateToken(id: number, actor: AuthUser) {
    const cur = await this.find(id);
    await this.assertAssignable(actor, cur.default_assignee_id); // cấp lại credential = dùng quyền của nguồn
    const token = generateInboundToken();
    const saved = await this.prisma.webhookInboundSource.update({
      where: { id },
      data: { token_hash: hashInboundToken(token), token_prefix: inboundTokenPrefix(token) },
    });
    await this.log(actor.userId, 'source.token_rotated', id);
    return { ...toSourceView(saved), token, path: `${INBOUND_PATH_PREFIX}${token}` };
  }

  async remove(id: number, actor: AuthUser): Promise<{ deleted: true }> {
    await this.find(id);
    await this.prisma.$transaction([
      this.prisma.webhookInboundReceipt.deleteMany({ where: { source_id: id } }),
      this.prisma.webhookInboundSource.delete({ where: { id } }),
    ]);
    await this.log(actor.userId, 'source.deleted', id);
    return { deleted: true };
  }
}
