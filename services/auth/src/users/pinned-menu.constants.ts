/**
 * Danh sách key menu hợp lệ để ghim ở sidebar.
 *
 * 🔴 PHẢI đồng bộ TAY với `apps/web/src/components/nav-config.ts` (field `key`
 * của mọi `MenuItem`/`ChildMenuItem`) — thêm/xoá menu ở đó thì cập nhật danh
 * sách này. BE chỉ kiểm KEY CÓ NẰM TRONG danh sách đã biết (chặn payload rác/
 * quá khổ), KHÔNG kiểm role hiện tại có thấy key đó hay không — việc ẩn mục
 * ghim mà role không còn quyền xem nằm ở FE (`isItemVisible`/`isChildVisible`
 * lọc lại MỌI mục ghim trước khi render, kể cả mục đọc từ đây), nên 1 key
 * "thừa" tồn tại trong DB không lộ đường dẫn nào cho user không có quyền.
 */
export const KNOWN_MENU_KEYS = [
  'dashboard',
  'contacts',
  'projects',
  'reports',
  'newsfeed',
  'social',
  'kanban',
  'attendance',
  'payroll',
  'management',
  'management_employees',
  'management_contracts',
  'management_job_titles',
  'management_recruitment',
  'management_workdays',
  'connections',
  'settings',
] as const;

export type KnownMenuKey = (typeof KNOWN_MENU_KEYS)[number];

/**
 * Trần số mục ghim. PHẢI bằng `MAX_PINS` ở `apps/web/src/hooks/use-pinned-menus.ts`
 * (FE chặn thao tác kèm thông báo, BE chặn payload bất thường); có test giữ hai số khớp nhau.
 */
export const MAX_PINNED_MENU_KEYS = 20;

/**
 * Mục menu của bảng tuỳ biến (custom object), do FE dựng ở `menu-custom.ts`:
 * `custom_<object_key>` hoặc `custom_<object_key>__<view_key>` (màn xem riêng).
 * Key đối tượng/màn theo `KEY_REGEX` của custom-objects (a-z, 0-9, `_`, bắt đầu bằng chữ, tối đa 48 ký tự).
 * Vì key có thể chứa `__` nên dấu tách đối tượng/màn mơ hồ: DTO chỉ kiểm hình dạng chặt + độ dài,
 * còn tách và kiểm tồn tại làm ở service (`parseCustomMenuKey`).
 */
export const CUSTOM_MENU_KEY_PREFIX = 'custom_';
export const CUSTOM_MENU_KEY_REGEX = /^custom_[a-z][a-z0-9_]{0,96}$/;
const PART_REGEX = /^[a-z][a-z0-9_]{0,47}$/;

export function isKnownMenuKey(key: string): boolean {
  return (KNOWN_MENU_KEYS as readonly string[]).includes(key);
}

export function isCustomMenuKey(key: unknown): key is string {
  return typeof key === 'string' && CUSTOM_MENU_KEY_REGEX.test(key);
}

export interface CustomMenuTarget {
  objectKey: string;
  viewKey: string | null;
}

/** Mọi cách hiểu hợp lệ của một key `custom_…` (cả bảng, và từng điểm tách `__` thành bảng + màn). */
export function parseCustomMenuKey(key: string): CustomMenuTarget[] {
  if (!isCustomMenuKey(key)) return [];
  const rest = key.slice(CUSTOM_MENU_KEY_PREFIX.length);
  const out: CustomMenuTarget[] = [];
  if (PART_REGEX.test(rest)) out.push({ objectKey: rest, viewKey: null });
  for (let i = rest.indexOf('__'); i !== -1; i = rest.indexOf('__', i + 1)) {
    const objectKey = rest.slice(0, i);
    const viewKey = rest.slice(i + 2);
    if (PART_REGEX.test(objectKey) && PART_REGEX.test(viewKey)) out.push({ objectKey, viewKey });
  }
  return out;
}
