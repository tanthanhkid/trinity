import type { Grants } from '@trinity/rbac';

/** Bản sao grants có `contacts.phone_full` để kiểm `restrictForAi` không sửa đối tượng gốc. */
export function adminGrantsForTest(): Grants {
  return { 'contacts.view': 'all', 'contacts.phone_full': 'all' };
}
