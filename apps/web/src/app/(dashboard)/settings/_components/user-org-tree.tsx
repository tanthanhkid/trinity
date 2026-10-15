'use client'

import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { ChevronDown, ChevronRight, Pencil, Network } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'

/** Người dùng trong cây — `roles` là TÊN các vai trò đang giữ (BE `GET /users`). */
export interface OrgUser {
  id: number
  email: string
  full_name: string
  roles?: string[]
  manager_id?: number | null
  status: 'active' | 'locked'
  avatar_url?: string | null
}

interface Props {
  users: OrgUser[]
  search: string
  canManage: boolean
  onEdit: (user: OrgUser) => void
}

interface TreeNode {
  user: OrgUser
  children: TreeNode[]
}

const MAX_ROLE_CHIPS = 3

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function sortByName(a: OrgUser, b: OrgUser) {
  return a.full_name.localeCompare(b.full_name, 'vi')
}

/**
 * Cây theo `manager_id` TỰ DO (không cố định số cấp). Gốc = người không có quản lý HOẶC quản lý nằm ngoài tập đang
 * thấy (người xem chỉ có phạm vi hẹp); vòng lặp bất thường vẫn không làm mất
 * người nào (gom nốt thành gốc).
 */
export function buildTree(users: OrgUser[]): TreeNode[] {
  const ids = new Set(users.map((u) => u.id))
  const byManager = new Map<number, OrgUser[]>()
  const roots: OrgUser[] = []
  for (const u of users) {
    if (u.manager_id != null && ids.has(u.manager_id) && u.manager_id !== u.id) {
      const arr = byManager.get(u.manager_id) ?? []
      arr.push(u)
      byManager.set(u.manager_id, arr)
    } else {
      roots.push(u)
    }
  }
  const placed = new Set<number>()
  const build = (u: OrgUser): TreeNode => {
    placed.add(u.id)
    const kids = (byManager.get(u.id) ?? []).filter((k) => !placed.has(k.id)).sort(sortByName)
    return { user: u, children: kids.map(build) }
  }
  const tree = roots.sort(sortByName).map(build)
  for (const u of users.slice().sort(sortByName)) if (!placed.has(u.id)) tree.push(build(u))
  return tree
}

function matches(u: OrgUser, q: string): boolean {
  if (!q) return true
  const s = q.toLowerCase()
  return (
    u.full_name.toLowerCase().includes(s) ||
    u.email.toLowerCase().includes(s) ||
    (u.roles ?? []).some((r) => r.toLowerCase().includes(s))
  )
}

function filterTree(nodes: TreeNode[], q: string): TreeNode[] {
  if (!q) return nodes
  const out: TreeNode[] = []
  for (const n of nodes) {
    const kids = filterTree(n.children, q)
    if (matches(n.user, q) || kids.length > 0) out.push({ user: n.user, children: kids })
  }
  return out
}

function collectIds(nodes: TreeNode[], into: Set<number>) {
  for (const n of nodes) {
    into.add(n.user.id)
    collectIds(n.children, into)
  }
}

function RoleChips({ roles }: { roles: string[] }) {
  if (roles.length === 0) {
    return (
      <Badge variant="secondary" className="bg-amber-50 text-amber-800">
        Chưa gán vai trò
      </Badge>
    )
  }
  return (
    <>
      {roles.slice(0, MAX_ROLE_CHIPS).map((r, i) => (
        <Badge
          key={r}
          variant="secondary"
          className={`bg-[var(--color-app-primary-soft)] text-[var(--color-app-primary-ink)]${i > 0 ? ' max-sm:hidden' : ''}`}
        >
          {r}
        </Badge>
      ))}
      {roles.length > 1 && (
        <Badge variant="secondary" className="hidden bg-gray-100 text-gray-700 max-sm:inline-flex" title={roles.slice(1).join(', ')}>
          +{roles.length - 1}
        </Badge>
      )}
      {roles.length > MAX_ROLE_CHIPS && (
        <Badge variant="secondary" className="bg-gray-100 text-gray-700 max-sm:hidden" title={roles.slice(MAX_ROLE_CHIPS).join(', ')}>
          +{roles.length - MAX_ROLE_CHIPS}
        </Badge>
      )}
    </>
  )
}

interface RowProps {
  user: OrgUser
  depth: number
  childCount: number
  expanded: boolean
  onToggle: () => void
  canManage: boolean
  onEdit: (u: OrgUser) => void
}

function UserRow({ user, depth, childCount, expanded, onToggle, canManage, onEdit }: RowProps) {
  return (
    <div
      className="group flex items-center gap-3 rounded-xl px-2 py-2 pl-[var(--indent)] transition-colors hover:bg-muted/60 max-sm:gap-2 max-sm:pl-[var(--indent-phone)]"
      // Điện thoại: thụt lề tối đa 3 cấp (16px/cấp), cấp sâu hơn hiện nhãn "Cấp N" — desktop giữ 28px/cấp.
      style={
        {
          '--indent': `${8 + depth * 28}px`,
          '--indent-phone': `${8 + Math.min(depth, 3) * 16}px`,
        } as CSSProperties
      }
    >
      {childCount > 0 ? (
        <button
          type="button"
          onClick={onToggle}
          className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-gray-100 max-sm:after:absolute max-sm:after:-inset-2.5"
          aria-label={expanded ? 'Thu gọn' : 'Mở rộng'}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
      ) : (
        <span className="h-6 w-6 shrink-0" />
      )}
      <Avatar className="h-9 w-9 shrink-0">
        <AvatarImage src={user.avatar_url ?? undefined} alt={user.full_name} />
        <AvatarFallback className="bg-[var(--color-app-primary-soft)] text-xs font-semibold text-[var(--color-app-primary-ink)]">
          {initials(user.full_name)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-gray-900">{user.full_name}</span>
          {depth > 3 && <span className="hidden text-xs text-muted-foreground max-sm:inline">Cấp {depth + 1}</span>}
          <RoleChips roles={user.roles ?? []} />
          {childCount > 0 && <span className="text-xs text-muted-foreground">({childCount} trực thuộc)</span>}
          {user.status === 'locked' && (
            <Badge variant="secondary" className="bg-red-50 text-red-700">
              Đã khoá
            </Badge>
          )}
        </div>
        <div className="truncate font-mono text-xs text-muted-foreground">{user.email}</div>
      </div>
      {canManage && (
        <Button
          variant="ghost"
          size="icon"
          className="opacity-40 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 max-sm:opacity-100"
          onClick={() => onEdit(user)}
          aria-label={`Sửa người dùng ${user.full_name}`}
          title="Sửa / Gán vai trò / Cài lại mật khẩu"
        >
          <Pencil className="h-4 w-4" />
        </Button>
      )}
    </div>
  )
}

interface BranchProps {
  nodes: TreeNode[]
  depth: number
  expanded: Set<number>
  toggle: (id: number) => void
  canManage: boolean
  onEdit: (u: OrgUser) => void
}

function TreeBranch({ nodes, depth, expanded, toggle, canManage, onEdit }: BranchProps) {
  return (
    <>
      {nodes.map((n) => {
        const isOpen = expanded.has(n.user.id)
        return (
          <div key={n.user.id}>
            <UserRow
              user={n.user}
              depth={depth}
              childCount={n.children.length}
              expanded={isOpen}
              onToggle={() => toggle(n.user.id)}
              canManage={canManage}
              onEdit={onEdit}
            />
            {n.children.length > 0 && isOpen && (
              <TreeBranch nodes={n.children} depth={depth + 1} expanded={expanded} toggle={toggle} canManage={canManage} onEdit={onEdit} />
            )}
          </div>
        )
      })}
    </>
  )
}

export function UserOrgTree({ users, search, canManage, onEdit }: Props) {
  const tree = useMemo(() => buildTree(users), [users])
  const filtered = useMemo(() => filterTree(tree, search), [tree, search])
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  // Có từ khoá → mở hết để không che kết quả; không → mở cấp gốc.
  useEffect(() => {
    const ids = new Set<number>()
    if (search) collectIds(filtered, ids)
    else for (const n of filtered) ids.add(n.user.id)
    setExpanded(ids)
  }, [search, filtered])

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <section className="rounded-[var(--radius)] border bg-white p-4 max-sm:p-2 shadow-[0_4px_16px_rgba(0,0,0,0.06)]">
      <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
        <Network className="h-4 w-4 text-[var(--color-app-primary-ink)]" />
        <h3 className="text-sm font-semibold">Sơ đồ người dùng theo quản lý trực tiếp</h3>
        <span className="text-xs text-muted-foreground">
          Cây theo người quản lý; vai trò quyết định quyền, không quyết định vị trí trong cây.
        </span>
      </header>
      {filtered.length === 0 ? (
        <div className="px-3 py-6 text-center text-sm text-muted-foreground">
          {search ? 'Không có kết quả phù hợp' : 'Chưa có dữ liệu'}
        </div>
      ) : (
        <TreeBranch nodes={filtered} depth={0} expanded={expanded} toggle={toggle} canManage={canManage} onEdit={onEdit} />
      )}
    </section>
  )
}
