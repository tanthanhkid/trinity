/**
 * Danh sách ÁP DỤNG (opt-in enforcement) cho "Đăng nhập theo wifi văn phòng".
 *
 * ⚠️ NGỮ NGHĨA CHỐT (đọc kỹ trước khi sửa) — file này là danh sách người
 * PHẢI bị kiểm tra khi công tắc BẬT, KHÔNG PHẢI danh sách được miễn:
 * - Bật công tắc + user KHÔNG nằm trong bất kỳ scope nào đã cấu hình → cho
 *   qua thẳng, KHÔNG chạy IP-match (`checkLoginWifi` union-IP logic).
 * - Bật công tắc + user CÓ nằm trong scope đã cấu hình → mới chạy tiếp
 *   IP-match (xem `login-wifi-check.helper.ts`).
 * - Danh sách RỖNG (0 dòng trong `login_wifi_check_targets`) trong khi công
 *   tắc đang BẬT = KHÔNG ai bị kiểm tra — đây là fail-open CỐ Ý ("người nào
 *   không được chọn thì không sao"). Rỗng nghĩa là "áp dụng cho 0 người",
 *   không phải một nhánh lỗi cần fallback. TUYỆT ĐỐI KHÔNG đổi thành "rỗng =
 *   áp dụng cho MỌI người" — làm vậy biến 1 config rỗng thành khoá hàng loạt.
 *
 * 3 scope_type — theo cây quản lý `manager_id`. Chọn 1 node tổ chức thì áp dụng
 * cho CHÍNH người đó + toàn bộ subtree — kể cả nhân viên GIA NHẬP SAU khi cấu hình
 * (đánh đổi có chủ đích: chọn "team X" thường có ý định áp dụng cho toàn team X
 * liên tục, không phải chỉ đúng roster tại thời điểm bấm lưu):
 * - 'department': target_user_id = 1 quản lý cấp phòng → áp dụng người đó + mọi
 *   quản lý nhóm dưới quyền + mọi nhân viên dưới các nhóm đó (subtree 2 cấp).
 * - 'team': target_user_id = 1 quản lý nhóm → áp dụng người đó + mọi nhân viên
 *   báo cáo trực tiếp (subtree 1 cấp).
 * - 'user': target_user_id = 1 nhân viên bất kỳ (không giới hạn vai trò).
 *
 * Auth là service NestJS riêng (build/deploy độc lập, không import chéo giữa
 * services) — các hàm ở đây KHÔNG inject `PrismaService` qua DI (tránh đổi
 * constructor của `AuthService`) mà nhận `prisma` như tham số, giống cách
 * `isLoginWifiCheckBypassed` v.v. đã làm trong `login-wifi-check.helper.ts`.
 */

export type LoginWifiCheckScopeType = 'department' | 'team' | 'user'

export const LOGIN_WIFI_CHECK_SCOPE_TYPES: readonly LoginWifiCheckScopeType[] = [
  'department',
  'team',
  'user',
]

export interface LoginWifiCheckTargetRow {
  scope_type: string
  target_user_id: number
}

export interface LoginWifiTargetSets {
  userIds: Set<number>
  teamLeadIds: Set<number>
  departmentIds: Set<number>
}

/** Nhóm các dòng cấu hình RAW theo 3 scope_type — hàm THUẦN, dễ unit test. */
export function groupLoginWifiTargets(rows: LoginWifiCheckTargetRow[]): LoginWifiTargetSets {
  const sets: LoginWifiTargetSets = {
    userIds: new Set(),
    teamLeadIds: new Set(),
    departmentIds: new Set(),
  }
  for (const row of rows) {
    if (row.scope_type === 'user') sets.userIds.add(row.target_user_id)
    else if (row.scope_type === 'team') sets.teamLeadIds.add(row.target_user_id)
    else if (row.scope_type === 'department') sets.departmentIds.add(row.target_user_id)
  }
  return sets
}

/** Chain quản lý 2 cấp của user đang đăng nhập — đủ để resolve CẢ 3 scope_type. */
export interface LoginUserManagerChain {
  userId: number
  managerId: number | null
  grandManagerId: number | null
}

/**
 * true nếu `chain.userId` nằm trong phạm vi ÁP DỤNG đã cấu hình — hàm THUẦN,
 * không đụng DB, để unit test không cần mock Prisma. Xem JSDoc đầu file cho
 * ngữ nghĩa từng scope_type.
 */
export function isLoginWifiTargeted(
  chain: LoginUserManagerChain,
  sets: LoginWifiTargetSets,
): boolean {
  // Chính người này được chọn trực tiếp (bất kỳ scope nào cũng có thể trỏ
  // đúng userId — vd 1 quản lý phòng tự bị chọn qua scope "department").
  if (sets.userIds.has(chain.userId)) return true
  if (sets.teamLeadIds.has(chain.userId)) return true
  if (sets.departmentIds.has(chain.userId)) return true

  // Báo cáo trực tiếp cho 1 quản lý nhóm/quản lý phòng nằm trong danh sách
  // (subtree 1 cấp).
  if (chain.managerId != null) {
    if (sets.teamLeadIds.has(chain.managerId)) return true
    if (sets.departmentIds.has(chain.managerId)) return true
  }

  // Nhân viên dưới 1 quản lý nhóm dưới 1 quản lý phòng nằm trong danh sách
  // (department subtree 2 cấp — cấp thứ 2).
  if (chain.grandManagerId != null && sets.departmentIds.has(chain.grandManagerId)) return true

  return false
}

/** Interface tối thiểu Prisma cần cho `resolveLoginWifiTargetedForUser` — mirror
 * `PrismaUserLike` của CRM `rbac-filter.helper.ts` (decouple khỏi DI container). */
export interface PrismaLoginWifiTargetLike {
  loginWifiCheckTarget: {
    findMany: (args: {
      select: { scope_type: true; target_user_id: true }
    }) => Promise<LoginWifiCheckTargetRow[]>
  }
  user: {
    findUnique: (args: {
      where: { id: number }
      select: { id: true; manager_id: true; manager: { select: { manager_id: true } } }
    }) => Promise<{
      id: number
      manager_id: number | null
      manager: { manager_id: number | null } | null
    } | null>
  }
}

/**
 * Resolve userId đang đăng nhập có bị áp dụng gate wifi hay không.
 *
 * RẺ (theo yêu cầu): `login_wifi_check_targets` là bảng CẤU HÌNH admin
 * (bounded theo SỐ DÒNG ADMIN CHỌN — phòng/team/nhân viên, KHÔNG theo tổng số
 * nhân viên công ty), fetch TOÀN BỘ không WHERE — mirror
 * `attendanceOffice.findMany({where:{is_active:true,...}})` đã dùng ngay
 * trong `checkLoginWifi()`. Cộng 1 query `findUnique` theo PK (userId) lấy
 * chain quản lý 2 cấp — indexed, O(1). KHÔNG N+1, KHÔNG quét bảng lớn.
 *
 * FAIL-OPEN TUYỆT ĐỐI: lỗi DB/bất kỳ lỗi không lường trước → trả `false`
 * ("không bị áp dụng" → `checkLoginWifi` bỏ qua IP-match) — KHÔNG BAO GIỜ
 * throw ra ngoài để lỗi hạ tầng biến thành chặn login hàng loạt, đúng tinh
 * thần fail-open toàn bộ file `login-wifi-check.helper.ts`.
 */
export async function resolveLoginWifiTargetedForUser(
  prisma: PrismaLoginWifiTargetLike,
  userId: number,
): Promise<boolean> {
  try {
    // Đọc bảng cấu hình TRƯỚC, KHÔNG Promise.all với query chain quản lý
    // trường hợp phổ biến NHẤT (chưa cấu hình gì / vừa xoá sạch) chỉ tốn
    // ĐÚNG 1 query thay vì luôn luôn 2, đúng yêu cầu "đường login phải RẺ".
    const rows = await prisma.loginWifiCheckTarget.findMany({
      select: { scope_type: true, target_user_id: true },
    })
    if (rows.length === 0) return false

    const chainRow = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, manager_id: true, manager: { select: { manager_id: true } } },
    })
    if (!chainRow) return false

    const sets = groupLoginWifiTargets(rows)
    return isLoginWifiTargeted(
      {
        userId: chainRow.id,
        managerId: chainRow.manager_id,
        grandManagerId: chainRow.manager?.manager_id ?? null,
      },
      sets,
    )
  } catch {
    return false
  }
}
