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
 * Trần kỹ thuật server-side (rộng rãi hơn gợi ý UX "~5" ở FE — FE mới là nơi
 * chặn thao tác, BE chỉ chống payload bất thường).
 */
export const MAX_PINNED_MENU_KEYS = 12;
