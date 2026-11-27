/** Trang Thành viên: ba vai trò cố định + gộp thành viên với lời mời chờ thành một danh sách. */

export type MemberRole = "owner" | "admin" | "member"
export type MemberStatus = "active" | "locked" | "invited" | "invite_expired"

export const ROLE_LABEL: Record<MemberRole, string> = {
  owner: "Chủ sở hữu",
  admin: "Quản trị",
  member: "Thành viên",
}

export const ROLE_HINT: Record<MemberRole, string> = {
  owner: "Quản lý gói, chuyển quyền chủ và mọi việc của Quản trị",
  admin: "Mời, xoá thành viên và cài đặt công ty",
  member: "Dùng nghiệp vụ hằng ngày (khách, deal, việc)",
}

export const STATUS_LABEL: Record<MemberStatus, string> = {
  active: "Đang hoạt động",
  locked: "Tạm khoá",
  invited: "Đã mời, chưa vào",
  invite_expired: "Lời mời hết hạn",
}

/** `GET /members`. */
export interface MembersPayload {
  members: Array<{
    id: number
    full_name: string
    email: string | null
    role: MemberRole
    status: "active" | "locked"
    joined_at: string
  }>
  me: { id: number; role: MemberRole }
  roles: { admin_role_id: number | null; member_role_id: number | null }
  max_users: number | null
  owner_id: number | null
}

/** Một dòng của `GET /auth/invitations`. */
export interface InviteLite {
  id: number
  email: string
  role_id: number | null
  status: "pending" | "accepted" | "revoked" | "expired" | "unusable"
  expires_at: string
}

export interface MemberRow {
  key: string
  kind: "member" | "invite"
  id: number
  name: string
  email: string | null
  role: MemberRole
  status: MemberStatus
  /** Ngày tham gia (thành viên) hoặc hạn lời mời (lời mời). */
  date: string | null
  /** Có là chính người đang xem. */
  self: boolean
  roleId?: number | null
}

/** Vai trò (admin/member) của một lời mời theo `role_id`; không rõ ⇒ Thành viên. */
export function inviteRole(roleId: number | null, roles: MembersPayload["roles"]): MemberRole {
  return roleId !== null && roleId === roles.admin_role_id ? "admin" : "member"
}

/** Gộp thành viên (trước) và lời mời chờ (sau); lời mời đã nhận hoặc đã thu hồi không hiện. */
export function buildRows(data: MembersPayload, invites: InviteLite[]): MemberRow[] {
  const rows: MemberRow[] = data.members.map((m) => ({
    key: `m${m.id}`,
    kind: "member",
    id: m.id,
    name: m.full_name,
    email: m.email,
    role: m.role,
    status: m.status,
    date: m.joined_at,
    self: m.id === data.me.id,
  }))
  for (const i of invites) {
    if (i.status === "accepted" || i.status === "revoked") continue
    rows.push({
      key: `i${i.id}`,
      kind: "invite",
      id: i.id,
      name: i.email,
      email: i.email,
      role: inviteRole(i.role_id, data.roles),
      status: i.status === "pending" ? "invited" : "invite_expired",
      date: i.expires_at,
      self: false,
      roleId: i.role_id,
    })
  }
  return rows
}

/** Số chỗ đã dùng của gói: thành viên đang hoạt động + lời mời còn hiệu lực. */
export function usedSeats(rows: MemberRow[]): number {
  return rows.filter((r) => r.status === "active" || r.status === "invited").length
}

export type RowAction = "role" | "password" | "lock" | "unlock" | "remove" | "owner"

/** Thao tác có trong menu "…" của một dòng thành viên; lời mời dùng nút riêng. */
export function rowActions(row: MemberRow, me: MembersPayload["me"]): RowAction[] {
  if (row.kind !== "member" || row.self || row.role === "owner") return []
  if (me.role === "member") return []
  const a: RowAction[] = ["role", "password", row.status === "locked" ? "unlock" : "lock"]
  if (me.role === "owner" && row.status === "active") a.push("owner")
  a.push("remove")
  return a
}
