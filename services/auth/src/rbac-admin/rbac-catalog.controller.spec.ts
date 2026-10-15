import { ALL_PERMISSIONS, PERMISSION_GROUPS } from '@trinity/rbac'
import { RbacCatalogController } from './rbac-catalog.controller'

describe('RbacCatalogController', () => {
  it('trả đủ nhóm, đủ quyền, 4 mức phạm vi', () => {
    const controller = new RbacCatalogController()
    const result = controller.getCatalog()

    expect(result.groups).toEqual(PERMISSION_GROUPS)
    expect(result.permissions).toHaveLength(ALL_PERMISSIONS.length)
    expect(result.permissions[0]).toHaveProperty('key')
    expect(result.permissions[0]).toHaveProperty('label')
    expect(result.permissions[0]).toHaveProperty('group')
    expect(result.scopes.map((s) => s.value)).toEqual(['own', 'team', 'subtree', 'all'])
  })
})
