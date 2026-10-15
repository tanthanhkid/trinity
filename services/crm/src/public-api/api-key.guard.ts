import {
  CanActivate,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  Logger,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import * as crypto from 'crypto';
import { PrismaService } from '@trinity/prisma';

// API key lưu sẵn có thể còn chuỗi scope không còn dùng trong `scopes[]` — vô hại.
export type ApiKeyScope =
  | 'auth:login'
  | 'contacts:create'
  | 'deals:create'
  | 'tasks:create';

export const API_KEY_SCOPE = 'apiKey:scope';
export const ApiKeyScopeRequired = (scope: ApiKeyScope) =>
  SetMetadata(API_KEY_SCOPE, scope);

export interface ValidatedApiKey {
  id: number;
  name: string;
  scopes: string[];
  owner_user_id: number;
}

/**
 * Guard xác thực header `X-API-Key` + scope. Duplicate sang CRM để không
 * phải gọi HTTP về auth-service mỗi request — chỉ đọc bảng api_keys qua
 * Prisma (cùng DB, cùng schema @trinity/prisma).
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const scope = this.reflector.getAllAndOverride<ApiKeyScope>(
      API_KEY_SCOPE,
      [context.getHandler(), context.getClass()],
    );
    if (!scope) {
      // Config bug internal — không leak stack cho client.
      this.logger.error(
        `ApiKeyGuard applied without @ApiKeyScopeRequired() — handler=${context.getHandler().name}`,
      );
      throw new InternalServerErrorException('Cấu hình API key guard lỗi');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const rawKey = this.extractKey(request);
    if (!rawKey) {
      throw new UnauthorizedException('Thiếu X-API-Key header');
    }

    const hash = crypto
      .createHash('sha256')
      .update(rawKey.trim())
      .digest('hex');

    const record = await this.prisma.apiKey.findUnique({
      where: { key_hash: hash },
      select: {
        id: true,
        name: true,
        scopes: true,
        owner_user_id: true,
        revoked_at: true,
        expires_at: true,
      },
    });
    if (!record) {
      throw new UnauthorizedException('X-API-Key không hợp lệ');
    }
    if (record.revoked_at) {
      throw new UnauthorizedException('Khoá API đã bị thu hồi');
    }
    if (record.expires_at && record.expires_at.getTime() < Date.now()) {
      throw new UnauthorizedException('Khoá API đã hết hạn');
    }
    if (!record.scopes.includes(scope)) {
      throw new UnauthorizedException(
        `Khoá API không có phạm vi "${scope}"`,
      );
    }

    // Nếu owner bị lock (status != active) sau khi key được cấp, tự động reject —
    // tránh kẹt key "zombie" dùng danh nghĩa user đã khoá. Không có FK giữa 2 schema
    // nên query riêng.
    const owner = await this.prisma.user.findUnique({
      where: { id: record.owner_user_id },
      select: { status: true },
    });
    if (!owner || owner.status !== 'active') {
      throw new UnauthorizedException(
        'Owner user của khoá API không còn hoạt động',
      );
    }

    const ip = request.ip ?? request.socket.remoteAddress ?? null;
    this.prisma.apiKey
      .update({
        where: { id: record.id },
        data: { last_used_at: new Date(), last_used_ip: ip ?? null },
      })
      .catch((err: unknown) =>
        this.logger.warn(`ApiKey last_used update failed: ${String(err)}`),
      );

    (request as unknown as Record<string, unknown>).apiKey = {
      id: record.id,
      name: record.name,
      scopes: record.scopes,
      owner_user_id: record.owner_user_id,
    } satisfies ValidatedApiKey;
    return true;
  }

  private extractKey(req: Request): string {
    const header = req.headers['x-api-key'];
    if (Array.isArray(header)) return header[0] ?? '';
    return (header as string | undefined) ?? '';
  }
}

/**
 * Param decorator trả về ValidatedApiKey từ request (được gắn bởi guard).
 */
export interface PublicApiRequest extends Request {
  apiKey: ValidatedApiKey;
}
