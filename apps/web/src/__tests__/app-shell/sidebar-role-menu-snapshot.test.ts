import { describe, expect, it } from "vitest"
import { ALL_PERMISSIONS, PERMISSIONS, type Grants } from "@trinity/rbac"
import { menuItems } from "@/components/nav-config"
import { isChildVisible, isItemVisible } from "@/components/nav-visibility"
import { withExtraMenuItems } from "@/components/app-shell/menu-extra"

/**
 * 🔴 RBAC quyền + phạm vi — bản CŨ của file này chụp
 * snapshot theo 11 mã vai trò cố định (`isItemVisible(item, role, menuConfig,
 * dynamicMap, email)`). Vai trò không còn quyết định menu — quyền đến từ dữ
 * liệu admin cấu hình ở Cài đặt > Vai trò, KHÔNG còn hardcode trong
 * nguồn. Test nay chụp theo TỔ HỢP QUYỀN mẫu (mirror tinh thần gốc: khoá tập
 * menu hiển thị ứng với 1 tập `Grants` cụ thể, đổi khác đi ở `nav-config.ts`/
 * `nav-visibility.ts` sau này sẽ làm snapshot đỏ — xác nhận CHỦ ĐÍCH rồi chạy
 * `vitest -u`). Snapshot cũ (theo tên role) đã xoá — không còn ý nghĩa.
 */

/** Mọi quyền, scope rộng nhất — mirror `adminGrants()` của `@trinity/rbac-nest`. */
function fullGrants(): Grants {
  const g: Grants = {}
  for (const p of ALL_PERMISSIONS) g[p] = PERMISSIONS[p].scoped ? "all" : true
  return g
}

const GRANT_FIXTURES: Record<string, Grants> = {
  "Quản trị (mọi quyền)": fullGrants(),
  "Không có quyền gì": {},
  "Chỉ Khách hàng + Deal": { "contacts.view": "own", "deals.view": "own" },
  "Nhân sự + Lương": {
    "employees.view": "own",
    "contracts.view": "own",
    "recruitment.view": "own",
    "attendance.config": "own",
    "payroll.view": "own",
  },
  "Chỉ Báo cáo": {
    "reports.overview": "own",
  },
}

/** Tập key menu (`cha` hoặc `cha>con`) hiển thị với 1 tập `Grants`, dùng CHÍNH
 *  pipeline thật của sidebar (không tự suy lại RBAC). */
function visibleKeysForGrants(grants: Grants): string[] {
  const items = withExtraMenuItems(menuItems)
  const out: string[] = []
  for (const item of items) {
    if (!isItemVisible(item, grants)) continue
    if (item.children) {
      for (const child of item.children) {
        if (isChildVisible(child, grants)) {
          out.push(`${item.key}>${child.key}`)
        }
      }
    } else {
      out.push(item.key)
    }
  }
  return out
}

describe("Tập menu hiển thị theo tổ hợp quyền — snapshot chống drift", () => {
  it.each(Object.entries(GRANT_FIXTURES))("%s", (_label, grants) => {
    expect(visibleKeysForGrants(grants)).toMatchSnapshot()
  })
})
