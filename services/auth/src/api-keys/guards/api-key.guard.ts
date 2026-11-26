import {
  CanActivate,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  Logger,
  SetMetadata,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Request } from 'express'
import { resolveClientIp } from '@trinity/rbac-nest'
import { ApiKeysService } from '../api-keys.service'
import { ApiKeyScope } from '../dto/create-api-key.dto'

export const API_KEY_SCOPE = 'apiKey:scope'
export const ApiKeyScopeRequired = (scope: ApiKeyScope) =>
  SetMetadata(API_KEY_SCOPE, scope)

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name)

  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const scope =
      this.reflector.getAllAndOverride<ApiKeyScope>(API_KEY_SCOPE, [
        context.getHandler(),
        context.getClass(),
      ])
    if (!scope) {
      // Config bug — log nội bộ, KHÔNG leak stack cho client.
      this.logger.error(
        `ApiKeyGuard applied without @ApiKeyScopeRequired() — handler=${context.getHandler().name} class=${context.getClass().name}`,
      )
      throw new InternalServerErrorException('Cấu hình API key guard lỗi')
    }
    const request = context.switchToHttp().getRequest<Request>()
    const rawKey = this.extractKey(request)
    // IP khách từ hàm dùng chung (TRUSTED_PROXY); không tin được ⇒ không ghi IP sai vào last_used_ip.
    const ip = resolveClientIp(request).ip
    const validated = await this.apiKeys.validate(rawKey, scope, ip)
    ;(request as unknown as Record<string, unknown>)['apiKey'] = validated
    return true
  }

  private extractKey(req: Request): string {
    const header = req.headers['x-api-key']
    if (Array.isArray(header)) return header[0] ?? ''
    return (header as string | undefined) ?? ''
  }
}
