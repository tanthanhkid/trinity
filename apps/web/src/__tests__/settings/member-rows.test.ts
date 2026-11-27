import { describe, expect, it } from "vitest"
import {
  buildRows,
  inviteRole,
  rowActions,
  usedSeats,
  type InviteLite,
  type MembersPayload,
} from "@/app/(dashboard)/settings/_components/members/member-rows"

const data = (meRole: MembersPayload["me"]["role"] = "owner"): MembersPayload => ({
  members: [
    { id: 1, full_name: "Chủ", email: "chu@x.vn", role: "owner", status: "active", joined_at: "2026-01-01T00:00:00.000Z" },
    { id: 2, full_name: "Quản", email: "quan@x.vn", role: "admin", status: "active", joined_at: "2026-02-01T00:00:00.000Z" },
    { id: 3, full_name: "Viên", email: "vien@x.vn", role: "member", status: "locked", joined_at: "2026-03-01T00:00:00.000Z" },
  ],
  me: { id: meRole === "owner" ? 1 : meRole === "admin" ? 2 : 3, role: meRole },
  roles: { admin_role_id: 10, member_role_id: 11 },
  max_users: 5,
  owner_id: 1,
})

const inv = (id: number, status: InviteLite["status"], role_id: number | null = 11): InviteLite => ({
  id,
  email: `m${id}@x.vn`,
  role_id,
  status,
  expires_at: "2026-12-01T00:00:00.000Z",
})

describe("buildRows", () => {
  it("gộp thành viên và lời mời chờ; bỏ lời mời đã nhận/thu hồi", () => {
    const rows = buildRows(data(), [inv(1, "pending"), inv(2, "accepted"), inv(3, "revoked"), inv(4, "expired"), inv(5, "unusable", 10)])
    expect(rows.map((r) => r.key)).toEqual(["m1", "m2", "m3", "i1", "i4", "i5"])
    expect(rows.find((r) => r.key === "i1")).toMatchObject({ status: "invited", role: "member" })
    expect(rows.find((r) => r.key === "i4")?.status).toBe("invite_expired")
    expect(rows.find((r) => r.key === "i5")?.role).toBe("admin")
    expect(rows.find((r) => r.key === "m1")?.self).toBe(true)
  })

  it("chỗ đã dùng = đang hoạt động + lời mời còn hiệu lực (khoá và hết hạn không tính)", () => {
    expect(usedSeats(buildRows(data(), [inv(1, "pending"), inv(4, "expired")]))).toBe(3)
  })

  it("lời mời không rõ vai trò ⇒ Thành viên", () => {
    expect(inviteRole(null, data().roles)).toBe("member")
    expect(inviteRole(10, data().roles)).toBe("admin")
  })
})

describe("rowActions", () => {
  const rowOf = (d: MembersPayload, id: number) => buildRows(d, []).find((r) => r.id === id)!

  it("Chủ sở hữu: đủ thao tác trên người khác, kèm chuyển quyền chủ cho người đang hoạt động", () => {
    const d = data("owner")
    expect(rowActions(rowOf(d, 2), d.me)).toEqual(["role", "password", "lock", "owner", "remove"])
    expect(rowActions(rowOf(d, 3), d.me)).toEqual(["role", "password", "unlock", "remove"])
  })

  it("không có thao tác trên chính mình và trên Chủ sở hữu", () => {
    const d = data("admin")
    expect(rowActions(rowOf(d, 2), d.me)).toEqual([])
    expect(rowActions(rowOf(d, 1), d.me)).toEqual([])
  })

  it("Quản trị không có 'Chuyển quyền chủ'", () => {
    const d = data("admin")
    expect(rowActions(rowOf(d, 3), d.me)).not.toContain("owner")
  })

  it("Thành viên không có thao tác nào", () => {
    const d = data("member")
    expect(rowActions(rowOf(d, 2), d.me)).toEqual([])
  })
})
