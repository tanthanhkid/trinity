/* Bộ lọc Tổng quan — logic thuần, không React. Khớp BE
 * `DashboardFilterQuery` / `DashboardFilterRoster` (`dashboard-overview.filter.ts`). */

export interface DashboardFilterValue {
  deptHeadId: number | null
  teamLeadId: number | null
  userId: number | null
}

export interface RosterItem {
  id: number
  full_name: string
  /** Cha trực tiếp trong cây `users.manager_id`. */
  manager_id: number | null
}

export interface DashboardFilterRoster {
  dept_heads: RosterItem[]
  team_leads: RosterItem[]
  sales: RosterItem[]
}

export const EMPTY_FILTER: DashboardFilterValue = { deptHeadId: null, teamLeadId: null, userId: null }

export function isFilterActive(f: DashboardFilterValue): boolean {
  return f.deptHeadId !== null || f.teamLeadId !== null || f.userId !== null
}

/** Query string gửi BE — chỉ field có giá trị. */
export function filterToParams(f: DashboardFilterValue): Record<string, number> {
  const p: Record<string, number> = {}
  if (f.deptHeadId !== null) p.dept_head_id = f.deptHeadId
  if (f.teamLeadId !== null) p.team_lead_id = f.teamLeadId
  if (f.userId !== null) p.user_id = f.userId
  return p
}

/** Team hiện được chọn khi đã chọn Phòng: chỉ team có `manager_id` = phòng đó. */
export function teamOptions(roster: DashboardFilterRoster | undefined, f: DashboardFilterValue): RosterItem[] {
  const all = roster?.team_leads ?? []
  return f.deptHeadId === null ? all : all.filter((t) => t.manager_id === f.deptHeadId)
}

/** Sale hiện được chọn: theo Team nếu có, không thì theo mọi team của Phòng. */
export function saleOptions(roster: DashboardFilterRoster | undefined, f: DashboardFilterValue): RosterItem[] {
  const all = roster?.sales ?? []
  if (f.teamLeadId !== null) return all.filter((s) => s.manager_id === f.teamLeadId)
  if (f.deptHeadId !== null) {
    const teamIds = new Set(teamOptions(roster, f).map((t) => t.id))
    return all.filter((s) => s.manager_id !== null && (teamIds.has(s.manager_id) || s.manager_id === f.deptHeadId))
  }
  return all
}

/**
 * Đổi 1 ô lọc rồi bỏ các ô con không còn hợp lệ (đổi Phòng → Team/NV ngoài Phòng bị xoá).
 * Làm trong handler (KHÔNG useEffect+setState). "Chính tôi" (userId ngoài roster)
 * được giữ nguyên vì không thuộc nhánh Phòng/Team nào.
 */
export function applyFilterChange(
  roster: DashboardFilterRoster | undefined,
  prev: DashboardFilterValue,
  patch: Partial<DashboardFilterValue>,
): DashboardFilterValue {
  const next = { ...prev, ...patch }
  if (next.teamLeadId !== null && !teamOptions(roster, next).some((t) => t.id === next.teamLeadId)) {
    next.teamLeadId = null
  }
  const salesPool = roster?.sales ?? []
  const isRosterSale = next.userId !== null && salesPool.some((s) => s.id === next.userId)
  if (isRosterSale && !saleOptions(roster, next).some((s) => s.id === next.userId)) next.userId = null
  return next
}

/** Mô tả bộ lọc đang áp dụng, vd "Phòng A · Team B · NV C". `selfId` → "Chính tôi". */
export function describeFilter(
  roster: DashboardFilterRoster | undefined,
  f: DashboardFilterValue,
  selfId: number | null,
): string {
  const name = (list: RosterItem[] | undefined, id: number) =>
    list?.find((x) => x.id === id)?.full_name ?? `#${id}`
  const parts: string[] = []
  if (f.deptHeadId !== null) parts.push(`Phòng ${name(roster?.dept_heads, f.deptHeadId)}`)
  if (f.teamLeadId !== null) parts.push(`Team ${name(roster?.team_leads, f.teamLeadId)}`)
  if (f.userId !== null) {
    parts.push(f.userId === selfId ? 'Chính tôi' : `NV ${name(roster?.sales, f.userId)}`)
  }
  return parts.join(' · ')
}
