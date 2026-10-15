/**
 * Xếp hạng "cấp bậc" chức danh theo TÊN chức danh THỰC TẾ (KHÔNG dùng mã/ký hiệu
 * `rank_code`/`symbol` hay `sort_order`). Dùng để sắp xếp nhân viên trong từng Team
 * theo cơ cấu tổ chức, từ cao xuống thấp:
 *
 *   Trưởng nhóm / Team Lead → Chuyên viên chính → Chuyên viên → Nhân viên
 *
 * Số lớn hơn = chức danh cao hơn (đứng trước khi sort giảm dần). Chức danh không
 * khớp 4 nhóm trên → `UNKNOWN` (xếp cuối, tiebreak theo cấu hình sort_order ở caller).
 *
 * ⚠️ Thứ tự kiểm tra QUAN TRỌNG: "Chuyên viên chính" PHẢI kiểm TRƯỚC "Chuyên viên"
 * vì "chuyên viên" là chuỗi con của "chuyên viên chính" → nếu đảo thứ tự thì
 * "Chuyên viên chính" sẽ bị nhận nhầm thành "Chuyên viên".
 */
export const JOB_TITLE_RANK = {
  TEAM_LEAD: 4,
  SENIOR_SPECIALIST: 3,
  SPECIALIST: 2,
  STAFF: 1,
  UNKNOWN: 0,
} as const

export function jobTitleSeniorityRank(name: string | null | undefined): number {
  if (!name) return JOB_TITLE_RANK.UNKNOWN
  const s = name.toLowerCase().trim()
  // Cấp phó (Phó trưởng nhóm, Phó phòng…) — thấp hơn trưởng, xếp ngang chuyên viên chính
  if (s.startsWith("phó") || s.includes(" phó ")) {
    return JOB_TITLE_RANK.SENIOR_SPECIALIST
  }
  // Trưởng nhóm / Team Lead — cấp cao nhất trong một team
  if (s.includes("trưởng nhóm") || s.includes("team lead") || s.includes("trưởng")) {
    return JOB_TITLE_RANK.TEAM_LEAD
  }
  // Chuyên viên chính — PHẢI kiểm trước "chuyên viên" (substring)
  if (s.includes("chuyên viên chính") || (s.includes("chuyên viên") && s.includes("chính"))) {
    return JOB_TITLE_RANK.SENIOR_SPECIALIST
  }
  if (s.includes("chuyên viên")) {
    return JOB_TITLE_RANK.SPECIALIST
  }
  if (s.includes("nhân viên")) {
    return JOB_TITLE_RANK.STAFF
  }
  return JOB_TITLE_RANK.UNKNOWN
}
