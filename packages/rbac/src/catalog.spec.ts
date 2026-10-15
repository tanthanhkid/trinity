import { PERMISSIONS, PERMISSION_GROUPS, isPermission } from './catalog'

it('khoá đúng dạng nhóm.hành_động (cho phép 1 tầng con)', () => {
  for (const k of Object.keys(PERMISSIONS)) expect(k).toMatch(/^[a-z_]+(\.[a-z_]+){1,2}$/)
})
it('mọi quyền có nhãn tiếng Việt + nhóm hợp lệ', () => {
  for (const def of Object.values(PERMISSIONS)) {
    expect(def.label.length).toBeGreaterThan(2)
    expect(PERMISSION_GROUPS).toContain(def.group)
  }
})
it('isPermission', () => {
  expect(isPermission('contacts.view')).toBe(true)
  expect(isPermission('unknown.view')).toBe(false)
})

it('nhóm Kết nối & AI: 3 quyền, đều không scoped; webhooks + ai_admin là sensitive, ai_connect thì không', () => {
  const keys = ['integrations.webhooks', 'integrations.ai_connect', 'integrations.ai_admin'] as const
  for (const k of keys) {
    expect(isPermission(k)).toBe(true)
    expect(PERMISSIONS[k].group).toBe('Kết nối & AI')
    expect(PERMISSIONS[k].scoped).toBe(false)
  }
  expect('sensitive' in PERMISSIONS['integrations.webhooks']).toBe(true)
  expect('sensitive' in PERMISSIONS['integrations.ai_admin']).toBe(true)
  expect('sensitive' in PERMISSIONS['integrations.ai_connect']).toBe(false)
})

it('nhóm Tính năng tuỳ biến: cấu hình không scoped; dữ liệu scoped; xuất/xoá/SĐT là sensitive và là quyền RIÊNG', () => {
  expect(PERMISSIONS['custom_objects.manage']).toMatchObject({ group: 'Tính năng tuỳ biến', scoped: false, sensitive: true })
  for (const k of ['custom_records.view', 'custom_records.manage', 'custom_records.delete', 'custom_records.export', 'custom_records.phone_full'] as const) {
    expect(PERMISSIONS[k]).toMatchObject({ group: 'Tính năng tuỳ biến', scoped: true })
  }
  for (const k of ['custom_records.delete', 'custom_records.export', 'custom_records.phone_full'] as const) {
    expect('sensitive' in PERMISSIONS[k]).toBe(true)
  }
  expect('sensitive' in PERMISSIONS['custom_records.view']).toBe(false)
  // : SĐT tuỳ biến KHÔNG dùng chung quyền SĐT của phân hệ khác
  expect(isPermission('custom_records.phone_full')).toBe(true)
})
