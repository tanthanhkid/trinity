import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common'
import type { Permission } from '@trinity/rbac'
import type { AuthUser } from './auth-user'

export const RBAC_META = 'rbac:access'
export type AccessMeta =
  | { kind: 'can'; permissions: Permission[]; mode: 'all' | 'any' }
  | { kind: 'auth' }
  | { kind: 'public' }
  | { kind: 'internal' }

export const Can = (...permissions: Permission[]) =>
  SetMetadata(RBAC_META, { kind: 'can', permissions, mode: 'all' } satisfies AccessMeta)
export const CanAny = (...permissions: Permission[]) =>
  SetMetadata(RBAC_META, { kind: 'can', permissions, mode: 'any' } satisfies AccessMeta)
export const AuthOnly = () => SetMetadata(RBAC_META, { kind: 'auth' } satisfies AccessMeta)
export const Public = () => SetMetadata(RBAC_META, { kind: 'public' } satisfies AccessMeta)
/** Route service-to-service: kiểm header x-service-secret = INTERNAL_SERVICE_SECRET (fallback SERVICE_SECRET). */
export const Internal = () => SetMetadata(RBAC_META, { kind: 'internal' } satisfies AccessMeta)

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user as AuthUser
})
