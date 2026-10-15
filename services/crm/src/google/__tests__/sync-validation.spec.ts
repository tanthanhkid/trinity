import { ForbiddenException } from '@nestjs/common';
import { assertTargetPermission } from '../sync-validation';

const user = (grants: Record<string, unknown>, isAdmin = false) => ({ userId: 1, isAdmin, grants }) as never;

describe('assertTargetPermission — phạm vi xuất', () => {
  it('xuất khách với contacts.export phạm vi team → bị chặn', () => {
    expect(() => assertTargetPermission(user({ 'contacts.export': 'team' }), 'contact', 'export')).toThrow(ForbiddenException);
  });
  it('xuất khách với contacts.export phạm vi all → qua', () => {
    expect(() => assertTargetPermission(user({ 'contacts.export': 'all' }), 'contact', 'export')).not.toThrow();
  });
  it('xuất bảng tuỳ biến phạm vi own → bị chặn', () => {
    expect(() => assertTargetPermission(user({ 'custom_records.export': 'own' }), 'custom_object', 'export')).toThrow(ForbiddenException);
  });
  it('admin luôn qua', () => {
    expect(() => assertTargetPermission(user({}, true), 'contact', 'export')).not.toThrow();
  });
  it('nhập khách chỉ cần có quyền, không đòi phạm vi', () => {
    expect(() => assertTargetPermission(user({ 'contacts.create': 'own' }), 'contact', 'import')).not.toThrow();
  });
});
