import type { AuthUser } from '@trinity/rbac-nest'
import { JobTitlesController } from '../job-titles.controller'

const ROW = {
  id: 1, category: 'Nhân viên', rank_code: 'NV1', name: 'NV', symbol: 'N',
  base_salary: '8000000', standard_target: '50000000', default_insurance_salary: '5000000',
}
const svc = { findAll: jest.fn().mockResolvedValue([ROW]), findOne: jest.fn().mockResolvedValue(ROW) }
const ctrl = new JobTitlesController(svc as never)
const user = (grants: AuthUser['grants'], isAdmin = false): AuthUser => ({ userId: 1, email: 'a@b.c', isAdmin, grants })

describe('JobTitlesController — lương theo chức danh', () => {
  it('người chỉ đăng nhập: thấy danh mục nhưng KHÔNG thấy mức lương', async () => {
    const [row] = await ctrl.findAll({} as never, user({}))
    expect(row.name).toBe('NV')
    expect(row.base_salary).toBeNull()
    expect(row.standard_target).toBeNull()
    expect(row.default_insurance_salary).toBeNull()
    expect((await ctrl.findOne(1, user({}))).base_salary).toBeNull()
  })

  it('org.manage hoặc payroll.view hoặc admin: thấy đủ', async () => {
    expect((await ctrl.findOne(1, user({ 'org.manage': true }))).base_salary).toBe('8000000')
    expect((await ctrl.findOne(1, user({ 'payroll.view': 'own' }))).base_salary).toBe('8000000')
    expect((await ctrl.findOne(1, user({}, true))).base_salary).toBe('8000000')
  })
})
