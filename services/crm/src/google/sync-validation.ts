import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { can } from '@trinity/rbac';
import type { AuthUser } from '@trinity/rbac-nest';
import { type ColumnMap } from './sheet-mapping';

/** Chuẩn hoá + kiểm column_map: khoá ∈ danh sách cho phép, tên cột không rỗng/không trùng. */
export function validateColumnMap(raw: Record<string, string>, allowed: readonly string[]): ColumnMap {
  const out: ColumnMap = {};
  const cols = new Set<string>();
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (!allowed.includes(k)) throw new BadRequestException(`Trường "${k}" không được ánh xạ`);
    const col = String(v ?? '').trim().slice(0, 200);
    if (!col) continue;
    const norm = col.toLowerCase();
    if (cols.has(norm)) throw new BadRequestException(`Cột "${col}" bị ánh xạ cho hai trường`);
    cols.add(norm);
    out[k] = col;
  }
  if (Object.keys(out).length === 0) throw new BadRequestException('Cần ánh xạ ít nhất một cột');
  return out;
}

export function validateDedupe(kind: 'contact' | 'custom_object', key: string | undefined, map: ColumnMap, direction: 'import' | 'export'): string {
  if (direction === 'export') return 'id';
  const k = key || 'phone';
  if (kind === 'contact') {
    if (k !== 'phone' && k !== 'email') throw new BadRequestException('Khoá khử trùng của khách chỉ là phone hoặc email');
    if (!map.phone) throw new BadRequestException('Cần ánh xạ cột Số điện thoại');
    if (!map[k]) throw new BadRequestException('Khoá khử trùng phải là một trường đã ánh xạ');
    return k;
  }
  if (!map[k]) throw new BadRequestException('Khoá khử trùng phải là một trường đã ánh xạ');
  return k;
}

/**
 * Quyền theo đích + hướng. Admin qua hết (grants của admin đã đủ).
 * Xuất ra Sheet đọc dữ liệu cả tổ chức (không lọc theo người phụ trách) nên quyền xuất phải có phạm vi "all"
 * — người chỉ được xuất theo team/của mình không được đẩy dữ liệu cả công ty ra ngoài.
 */
export function assertTargetPermission(user: AuthUser, kind: 'contact' | 'custom_object', direction: 'import' | 'export'): void {
  const need = kind === 'contact' ? (direction === 'import' ? 'contacts.create' : 'contacts.export') : direction === 'import' ? 'custom_records.manage' : 'custom_records.export';
  const minScope = direction === 'export' ? 'all' : undefined;
  if (!user.isAdmin && !can(user.grants, need, minScope)) {
    throw new ForbiddenException(`Cần quyền "${need}"${minScope ? ' phạm vi toàn bộ' : ''} để cấu hình đồng bộ ${direction === 'import' ? 'nhập' : 'xuất'} này`);
  }
}
