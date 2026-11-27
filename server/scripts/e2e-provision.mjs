#!/usr/bin/env node
// W04: tạo thêm 2 tài khoản thử (Nhân sự, Trưởng phòng) trên DB tạm để đủ 5 role của Playwright (seed --sample chỉ có admin/lead/sale).
// Dùng: node e2e-provision.mjs <baseUrl> <adminEmail> <adminPassword> <matKhauChung>
const [base, email, password, shared] = process.argv.slice(2)
const call = async (method, path, body, token) => {
  const r = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${await r.text()}`)
  return r.json()
}
const { access_token: t } = await call('POST', '/auth/login', { email, password })
const make = async (roleName, grants, userEmail, fullName) => {
  const role = await call('POST', '/roles', { name: roleName, description: 'Tài khoản thử e2e', grants }, t)
  const user = await call('POST', '/users', { email: userEmail, full_name: fullName, password: shared }, t)
  await call('PUT', `/users/${user.id}/roles`, { roleIds: [role.id] }, t)
}
await make('Nhân sự (thử)', {
  'employees.view': 'all', 'employees.manage': true, 'contracts.view': 'all', 'contracts.manage': true,
  'recruitment.view': true, 'recruitment.manage': true, 'attendance.view': 'all', 'attendance.manage': 'all',
  'payroll.view': 'all', 'users.view': 'all',
}, 'nhansu@demo.local', 'Nhân sự thử')
await make('Trưởng phòng (thử)', {
  'contacts.view': 'subtree', 'contacts.create': true, 'kanban.view': 'subtree', 'reports.overview': 'subtree',
  'attendance.view': 'subtree', 'employees.view': 'subtree', 'users.view': 'subtree',
}, 'truongphong@demo.local', 'Trưởng phòng thử')
console.log('provisioned')
