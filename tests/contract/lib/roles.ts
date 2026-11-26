import { seedUser, type SeededUser } from './db.js'
import { golden, snap, type Role } from './golden.js'
import { api, freshIp, type Res } from './http.js'
import { loginAdmin, loginSeeded } from './session.js'

/**
 * Route đọc dữ liệu khách đổi hình dạng theo quyền (cột `shape_permissions` của `routes.json`): golden ghi cho 3 vai.
 * `sale` là token của người dùng đang được thử trong ca; Quản trị và Trưởng nhóm (xem mọi thứ, thấy SĐT đầy đủ) dựng một lần mỗi file.
 */
let leader: SeededUser | null = null
let adminToken = ''
let leaderToken = ''

export async function threeRoleTokens(saleToken: string): Promise<[Role, string][]> {
  if (!adminToken) adminToken = (await loginAdmin()).token
  if (!leader) {
    leader = await seedUser({
      label: 'leader',
      grants: { 'contacts.view': 'all', 'contacts.create': null, 'contacts.phone_full': 'all', 'deals.view': 'all', 'custom_records.view': 'all', 'custom_records.phone_full': 'all' },
    })
    leaderToken = (await loginSeeded(leader)).token
  }
  return [
    ['admin', adminToken],
    ['leader', leaderToken],
    ['sale', saleToken],
  ]
}

/** GET `path` bằng cả 3 vai, ghi golden `<ca>.<vai>.json`; trả response của `sale` để ca khẳng định tiếp. */
export async function goldenThreeRoles(caseName: string, path: string, saleToken: string): Promise<Res> {
  let saleRes: Res | undefined
  for (const [role, token] of await threeRoleTokens(saleToken)) {
    const res = await api.get(path, { token, ip: freshIp() })
    golden(caseName, role, snap(res))
    if (role === 'sale') saleRes = res
  }
  return saleRes as Res
}
