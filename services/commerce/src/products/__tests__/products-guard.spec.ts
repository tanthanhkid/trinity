import 'reflect-metadata';
import { PATH_METADATA } from '@nestjs/common/constants';
import { RBAC_META, type AccessMeta } from '@trinity/rbac-nest';
import { ProductsController } from '../products.controller';

/**
 * RBAC quyền + phạm vi: controller này KHÔNG còn khai
 * `@UseGuards(JwtAuthGuard, RolesGuard)` — Commerce service chạy trong monolith
 * dùng `PermissionGuard` toàn cục (đăng ký 1 lần ở `apps/monolith`). Bài test
 * cũ đọc `GUARDS_METADATA`/`ROLES_KEY` không còn áp dụng — thay bằng đọc
 * `RBAC_META` (khoá `@Can`/`@AuthOnly`/`@Public`/`@Internal`) từng handler,
 * mirror cách `PermissionGuard` thật sự đọc metadata (`getAllAndOverride`).
 */
const metaOf = (fn: Function): AccessMeta | undefined =>
  Reflect.getMetadata(RBAC_META, fn);

describe('ProductsController — khai báo quyền (RBAC quyền + phạm vi)', () => {
  it('findAll/findOne đòi quyền products.view', () => {
    for (const h of ['findAll', 'findOne'] as const) {
      expect(metaOf(ProductsController.prototype[h])).toEqual({
        kind: 'can',
        permissions: ['products.view'],
        mode: 'all',
      });
    }
  });

  it('create/update/remove đòi quyền products.manage', () => {
    expect(metaOf(ProductsController.prototype.create)).toEqual({
      kind: 'can',
      permissions: ['products.manage'],
      mode: 'all',
    });
    expect(metaOf(ProductsController.prototype.update)).toEqual({
      kind: 'can',
      permissions: ['products.manage'],
      mode: 'all',
    });
    expect(metaOf(ProductsController.prototype.remove)).toEqual({
      kind: 'can',
      permissions: ['products.manage'],
      mode: 'all',
    });
  });

  it('uploadImage cùng quyền products.manage — KHÔNG rộng hơn tạo/sửa', () => {
    expect(metaOf(ProductsController.prototype.uploadImage)).toEqual({
      kind: 'can',
      permissions: ['products.manage'],
      mode: 'all',
    });
  });

  it('KHÔNG có metadata rác cấp class ghi đè metadata cấp handler', () => {
    expect(Reflect.getMetadata(RBAC_META, ProductsController)).toBeUndefined();
  });

  it('route PATCH :id tồn tại', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ProductsController.prototype.update)).toBe(':id');
  });
});
