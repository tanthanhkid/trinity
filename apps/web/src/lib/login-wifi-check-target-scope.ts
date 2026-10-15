import type { LoginWifiCheckScopeType } from "@/hooks/use-login-wifi-check-targets"

/**
 * Preview CLIENT-SIDE cho danh sách áp dụng wifi check — mirror
 * CHÍNH XÁC ngữ nghĩa BE (`login-wifi-check-targets.helper.ts`
 * `isLoginWifiTargeted`): department = trưởng phòng + subtree 2 cấp, team = trưởng nhóm
 * + subtree 1 cấp, user = đúng 1 nhân viên. CHỈ dùng để hiển thị số người SẼ
 * bị áp dụng cho admin xem trước khi lưu — KHÔNG phải nguồn RBAC, BE luôn
 * resolve lại độc lập lúc login.
 */

export interface OrgScopeUser {
  id: number
  manager_id: number | null
}

export interface SelectedLoginWifiTarget {
  scope_type: LoginWifiCheckScopeType
  target_user_id: number
}

function directReportIds(users: OrgScopeUser[], managerId: number): number[] {
  return users.filter((u) => u.manager_id === managerId).map((u) => u.id)
}

/** ID nhân viên sẽ bị áp dụng theo 1 danh sách đã chọn — hợp của mọi scope. */
export function resolveLoginWifiTargetPreview(
  users: OrgScopeUser[],
  selected: SelectedLoginWifiTarget[],
): Set<number> {
  const result = new Set<number>()
  for (const item of selected) {
    if (item.scope_type === "user") {
      result.add(item.target_user_id)
    } else if (item.scope_type === "team") {
      result.add(item.target_user_id)
      for (const id of directReportIds(users, item.target_user_id)) result.add(id)
    } else if (item.scope_type === "department") {
      result.add(item.target_user_id)
      const direct = directReportIds(users, item.target_user_id)
      for (const id of direct) result.add(id)
      for (const teamLeadId of direct) {
        for (const id of directReportIds(users, teamLeadId)) result.add(id)
      }
    }
  }
  return result
}
