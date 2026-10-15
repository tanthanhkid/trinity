import { describe, expect, it } from "vitest"
import { buildTree, type OrgUser } from "@/app/(dashboard)/settings/_components/user-org-tree"

const u = (id: number, manager_id: number | null, name = `U${id}`): OrgUser => ({
  id, email: `${id}@t`, full_name: name, manager_id, status: "active", roles: [],
})

describe("buildTree — cây theo manager_id tự do", () => {
  it("gốc = không có quản lý; con lồng theo manager_id, không phụ thuộc vai trò", () => {
    const tree = buildTree([u(3, 2), u(1, null), u(2, 1)])
    expect(tree.map((n) => n.user.id)).toEqual([1])
    expect(tree[0].children[0].user.id).toBe(2)
    expect(tree[0].children[0].children[0].user.id).toBe(3)
  })

  it("quản lý nằm ngoài tập đang thấy (phạm vi hẹp) → người đó thành gốc, không mất", () => {
    const tree = buildTree([u(5, 99)])
    expect(tree.map((n) => n.user.id)).toEqual([5])
  })

  it("vòng lặp manager bất thường vẫn không làm mất người nào", () => {
    const tree = buildTree([u(1, 2), u(2, 1)])
    const ids: number[] = []
    const walk = (ns: typeof tree) => ns.forEach((n) => { ids.push(n.user.id); walk(n.children) })
    walk(tree)
    expect(ids.sort()).toEqual([1, 2])
  })
})
