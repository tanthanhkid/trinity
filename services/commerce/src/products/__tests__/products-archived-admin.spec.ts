import { ForbiddenException } from '@nestjs/common';
import type { AuthUser } from '@trinity/rbac-nest';
import { ProductsController } from '../products.controller';

/** Mục "đã xoá (lưu trữ)" chỉ Quản trị xem được — chặn ở API, không chỉ ẩn nút trên web (Codex #62). */
describe('GET /products?archived=true — chỉ Quản trị', () => {
  const findAll = jest.fn().mockResolvedValue([]);
  const controller = new ProductsController({ findAll } as never);
  const viewer = { userId: 2, isAdmin: false, grants: { 'products.view': true } } as unknown as AuthUser;
  const admin = { userId: 1, isAdmin: true, grants: {} } as unknown as AuthUser;

  beforeEach(() => findAll.mockClear());

  it('người có products.view nhưng không phải Quản trị ⇒ 403, không đọc DB', () => {
    expect(() => controller.findAll({ archived: true }, viewer)).toThrow(ForbiddenException);
    expect(findAll).not.toHaveBeenCalled();
  });

  it('Quản trị xem được; danh mục thường ai có quyền xem cũng được', async () => {
    await controller.findAll({ archived: true }, admin);
    await controller.findAll({}, viewer);
    expect(findAll).toHaveBeenCalledTimes(2);
  });
});
