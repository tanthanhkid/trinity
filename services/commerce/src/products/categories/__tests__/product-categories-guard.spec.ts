import 'reflect-metadata';
import { RBAC_META, type AccessMeta } from '@trinity/rbac-nest';
import { ProductCategoriesController } from '../product-categories.controller';

/**
 * RBAC quyền + phạm vi — xem docblock tương tự ở
 * `products/__tests__/products-guard.spec.ts`.
 */
const metaOf = (fn: Function): AccessMeta | undefined =>
  Reflect.getMetadata(RBAC_META, fn);

describe('ProductCategoriesController — khai báo quyền', () => {
  it('findAll/findOne/findAttributeDefs đòi quyền products.view', () => {
    for (const h of ['findAll', 'findOne', 'findAttributeDefs'] as const) {
      expect(metaOf(ProductCategoriesController.prototype[h])).toEqual({
        kind: 'can',
        permissions: ['products.view'],
        mode: 'all',
      });
    }
  });

  it('create/update/createAttributeDef đòi quyền products.manage (CÙNG quyền sửa sản phẩm)', () => {
    for (const handler of ['create', 'update', 'createAttributeDef'] as const) {
      expect(metaOf(ProductCategoriesController.prototype[handler])).toEqual({
        kind: 'can',
        permissions: ['products.manage'],
        mode: 'all',
      });
    }
  });

  it('KHÔNG có metadata rác cấp class ghi đè metadata cấp handler', () => {
    expect(Reflect.getMetadata(RBAC_META, ProductCategoriesController)).toBeUndefined();
  });
});
