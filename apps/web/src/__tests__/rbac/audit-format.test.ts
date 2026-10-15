import { describe, expect, it } from "vitest"
import { describeAudit, diffGrants, auditActionLabel } from "@/app/(dashboard)/settings/_components/roles/audit-format"
import type { AuditRow } from "@/app/(dashboard)/settings/_components/roles/use-roles-api"

const label = (k: string) => ({ "contacts.view": "Xem khách hàng", "deals.manage": "Tạo/sửa deal" })[k] ?? k
const row = (p: Partial<AuditRow>): AuditRow => ({
  id: 1, actor_id: 1, actor_name: "A", action: "role.grants", target_type: "role", target_id: 1,
  target_name: null, before: null, after: null, created_at: "2026-10-03T00:00:00Z", ...p,
})

describe("audit-format", () => {
  it("diffGrants: thêm / bỏ / đổi phạm vi, nhãn từ danh mục", () => {
    expect(
      diffGrants({ "contacts.view": "own" }, { "contacts.view": "all", "deals.manage": true }, label),
    ).toEqual(["~ Xem khách hàng: của mình → toàn công ty", "+ Tạo/sửa deal"])
    expect(diffGrants({ "deals.manage": true }, {}, label)).toEqual(["- Tạo/sửa deal"])
  })

  it("user.roles: người + vai trò thêm/gỡ", () => {
    const lines = describeAudit(
      row({ action: "user.roles", target_type: "user", target_id: 5, target_name: "Lan",
        before: { roleIds: [1], roles: ["Sale"] }, after: { roleIds: [2], roles: ["Kế toán"] } }),
      label,
    )
    expect(lines).toEqual(["Người dùng: Lan", "+ Kế toán", "- Sale"])
  })

  it("role.update: tên đổi", () => {
    expect(
      describeAudit(row({ action: "role.update", before: { name: "A", description: null }, after: { name: "B", description: null } }), label),
    ).toEqual(["Tên: A → B"])
  })

  it("nhãn hành động tiếng Việt, action lạ giữ nguyên", () => {
    expect(auditActionLabel("role.delete")).toBe("Xoá vai trò")
    expect(auditActionLabel("zzz")).toBe("zzz")
  })
})
