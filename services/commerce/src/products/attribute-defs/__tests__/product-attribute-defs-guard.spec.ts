import 'reflect-metadata';
import { RBAC_META, type AccessMeta } from '@trinity/rbac-nest';
import { ProductAttributeDefsController } from '../product-attribute-defs.controller';

/**
 * RBAC quyền + phạm vi — controller này KHÔNG có route GET
 * (sửa/xoá theo `id` cụ thể) nên `@Can('products.manage')` cấp CLASS là ĐÚNG,
 * không siết oan route nào.
 */
const metaOf = (fn: Function): AccessMeta | undefined =>
  Reflect.getMetadata(RBAC_META, fn);

describe('ProductAttributeDefsController — khai báo quyền', () => {
  it('CÓ @Can(products.manage) cấp CLASS', () => {
    expect(Reflect.getMetadata(RBAC_META, ProductAttributeDefsController)).toEqual({
      kind: 'can',
      permissions: ['products.manage'],
      mode: 'all',
    });
  });

  it('update/remove KHÔNG override metadata cấp class (kế thừa quyền products.manage)', () => {
    expect(metaOf(ProductAttributeDefsController.prototype.update)).toBeUndefined();
    expect(metaOf(ProductAttributeDefsController.prototype.remove)).toBeUndefined();
  });
});
