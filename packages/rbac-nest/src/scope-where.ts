import { NotFoundException } from '@nestjs/common'
import type { Permission } from '@trinity/rbac'
import type { AuthUser } from './auth-user'
import type { ScopeService } from './scope.service'

/** Ghép vào where nghiệp vụ bằng `AND: [scopeWhere(...), ...]` — KHÔNG spread. */
export function scopeWhere(owner: number[] | 'all', fields: string[]): Record<string, unknown> {
  if (owner === 'all') return {}
  return fields.length === 1
    ? { [fields[0]]: { in: owner } }
    : { OR: fields.map((f) => ({ [f]: { in: owner } })) }
}

/** Tài nguyên theo id ngoài phạm vi → 404, không 403. */
export async function assertInScope(
  scope: ScopeService,
  user: AuthUser,
  p: Permission,
  owners: (number | null | undefined)[],
): Promise<void> {
  const allowed = await scope.ownerIds(user, p)
  if (allowed === 'all') return
  if (allowed && owners.some((o) => o != null && allowed.includes(o))) return
  throw new NotFoundException('Không tìm thấy')
}

/** Giữ 3 số cuối, che toàn bộ đầu số — vd '0900000168' → '***168'. */
export function maskPhone(phone: string | null): string | null {
  if (!phone) return phone
  const d = phone.replace(/\D/g, '')
  return d.length <= 3 ? '***' : `***${d.slice(-3)}`
}

export async function maskPhoneFor(
  scope: ScopeService,
  user: AuthUser,
  p: Permission,
  ownerIds: (number | null | undefined)[],
  phone: string | null,
): Promise<string | null> {
  const allowed = await scope.ownerIds(user, p)
  if (allowed === 'all') return phone
  if (allowed && ownerIds.some((o) => o != null && allowed.includes(o))) return phone
  return maskPhone(phone)
}

/**
 * Ghi chú hiệu năng: danh sách dài gọi `ownerIds` 1 LẦN rồi mask từng dòng
 * bằng tập đã có, thay vì gọi lại `maskPhoneFor` (và query DB) cho mỗi dòng.
 */
export function makePhoneMasker(
  allowed: number[] | 'all',
): (ownerIds: (number | null | undefined)[], phone: string | null) => string | null {
  return (ownerIds, phone) => {
    if (allowed === 'all') return phone
    if (ownerIds.some((o) => o != null && allowed.includes(o))) return phone
    return maskPhone(phone)
  }
}
