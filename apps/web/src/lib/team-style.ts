// Tô màu nền ô "Team" theo trưởng nhóm (team_lead user id) — mỗi team 1 màu,
// chọn ổn định từ bảng màu theo id (cùng id luôn ra cùng màu). Người không
// thuộc team → không nền.
const TEAM_PALETTE: readonly string[] = [
  "bg-amber-100 text-amber-800",
  "bg-pink-100 text-pink-700",
  "bg-green-100 text-green-800",
  "bg-blue-100 text-blue-800",
  "bg-violet-100 text-violet-800",
  "bg-orange-100 text-orange-800",
  "bg-teal-100 text-teal-800",
  "bg-slate-200 text-slate-700",
]

/** Class nền cho ô Team theo team_lead id; rỗng nếu không thuộc team nào. */
export function teamColorClass(teamLeadId: number | null | undefined): string {
  if (teamLeadId == null) return ""
  return TEAM_PALETTE[Math.abs(teamLeadId) % TEAM_PALETTE.length]
}
