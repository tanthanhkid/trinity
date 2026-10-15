import type { AuditRow } from './use-roles-api'

const ACTION_LABEL: Record<string, string> = {
  'role.create': 'Tạo vai trò',
  'role.update': 'Đổi tên/mô tả vai trò',
  'role.delete': 'Xoá vai trò',
  'role.grants': 'Sửa quyền vai trò',
  'user.roles': 'Đổi vai trò của người dùng',
}

export function auditActionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action
}

type GrantMap = Record<string, string | true>

function asMap(v: unknown): GrantMap {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as GrantMap) : {}
}

const SCOPE_LABEL: Record<string, string> = {
  own: 'của mình',
  team: 'cấp dưới trực tiếp',
  subtree: 'toàn bộ cấp dưới',
  all: 'toàn công ty',
}

function show(label: string, v: string | true | undefined): string {
  return typeof v === 'string' ? `${label} (${SCOPE_LABEL[v] ?? v})` : label
}

/** Diff quyền trước/sau — mỗi dòng 1 thay đổi, nhãn tiếng Việt từ danh mục. */
export function diffGrants(before: unknown, after: unknown, labelOf: (key: string) => string): string[] {
  const b = asMap(before)
  const a = asMap(after)
  const lines: string[] = []
  for (const k of Object.keys(a)) {
    if (b[k] === undefined) lines.push(`+ ${show(labelOf(k), a[k])}`)
    else if (b[k] !== a[k]) lines.push(`~ ${labelOf(k)}: ${SCOPE_LABEL[String(b[k])] ?? 'có'} → ${SCOPE_LABEL[String(a[k])] ?? 'có'}`)
  }
  for (const k of Object.keys(b)) if (a[k] === undefined) lines.push(`- ${show(labelOf(k), b[k])}`)
  return lines
}

function names(v: unknown): string[] {
  const roles = (v as { roles?: unknown } | null)?.roles
  return Array.isArray(roles) ? roles.map(String) : []
}

/** Các dòng chi tiết hiển thị dưới mỗi bản ghi nhật ký. */
export function describeAudit(row: AuditRow, labelOf: (key: string) => string): string[] {
  switch (row.action) {
    case 'role.grants':
      return diffGrants(row.before, row.after, labelOf)
    case 'role.create': {
      const a = row.after as { name?: string; grants?: unknown } | null
      return [`Tên: ${a?.name ?? '—'}`, ...diffGrants({}, a?.grants, labelOf)]
    }
    case 'role.update': {
      const b = row.before as { name?: string; description?: string | null } | null
      const a = row.after as { name?: string; description?: string | null } | null
      const out: string[] = []
      if (b?.name !== a?.name) out.push(`Tên: ${b?.name ?? '—'} → ${a?.name ?? '—'}`)
      if ((b?.description ?? '') !== (a?.description ?? '')) out.push('Mô tả đã đổi')
      return out
    }
    case 'role.delete':
      return [`Tên: ${(row.before as { name?: string } | null)?.name ?? '—'}`]
    case 'user.roles': {
      const b = names(row.before)
      const a = names(row.after)
      const added = a.filter((x) => !b.includes(x))
      const removed = b.filter((x) => !a.includes(x))
      return [
        `Người dùng: ${row.target_name ?? `#${row.target_id}`}`,
        ...added.map((x) => `+ ${x}`),
        ...removed.map((x) => `- ${x}`),
      ]
    }
    default:
      return []
  }
}
