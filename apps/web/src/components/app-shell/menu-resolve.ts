import type { ChildMenuItem, MenuItem } from "@/components/nav-config"

/**
 * Mục menu đã "làm phẳng" — dùng cho nhóm "ĐÃ GHIM" + tìm kiếm điều hướng
 * trong command palette. Chỉ những mục CÓ href thật (leaf item
 * hoặc con của group) mới ghim được — mục cha thuần tuý (vd "Quản
 * lý") không có đích điều hướng riêng nên KHÔNG đưa vào danh sách này.
 */
export interface FlatMenuEntry {
  key: string
  title: string
  icon: MenuItem["icon"]
  href: string
  badgeLabel?: string
}

/**
 * Làm phẳng danh sách menu (đã qua `withExtraMenuItems`) thành các entry có href — KHÔNG lọc RBAC, caller
 * PHẢI tự lọc qua `isItemVisible`/`isChildVisible` (mirror cách `sidebar.tsx`
 * đang lọc `visibleItems`).
 */
export function flattenMenuEntries(items: readonly MenuItem[]): FlatMenuEntry[] {
  const out: FlatMenuEntry[] = []
  for (const item of items) {
    if (item.hidden || item.external) continue
    if (item.children) {
      for (const child of item.children as readonly ChildMenuItem[]) {
        if (child.hidden || !child.href) continue
        out.push({ key: child.key, title: child.title, icon: child.icon, href: child.href })
      }
      continue
    }
    if (!item.href) continue
    out.push({ key: item.key, title: item.title, icon: item.icon, href: item.href, badgeLabel: item.badgeLabel })
  }
  return out
}

/** Tra 1 entry theo key — dùng để dựng nhóm "ĐÃ GHIM" từ danh sách key đã lưu. */
export function findMenuEntry(
  flat: readonly FlatMenuEntry[],
  key: string,
): FlatMenuEntry | undefined {
  return flat.find((e) => e.key === key)
}

/**
 * Dựng danh sách hiển thị cho nhóm "ĐÃ GHIM".
 *
 * `visibleFlatEntries` PHẢI là danh sách đã lọc qua `isItemVisible`/
 * `isChildVisible` theo role HIỆN TẠI (xem `sidebar.tsx`) — key ghim không
 * còn nằm trong danh sách này (role đổi, mục bị ẩn qua `menuConfig` động...)
 * sẽ tự biến mất khỏi kết quả, KHÔNG cần logic riêng ở đây. Đây chính là cách
 * đáp ứng yêu cầu "ghim mục không còn quyền thì không hiện, không lộ link".
 */
export function resolvePinnedEntries(
  pinnedKeys: readonly string[],
  visibleFlatEntries: readonly FlatMenuEntry[],
): FlatMenuEntry[] {
  const out: FlatMenuEntry[] = []
  for (const key of pinnedKeys) {
    const entry = findMenuEntry(visibleFlatEntries, key)
    if (entry) out.push(entry)
  }
  return out
}

/**
 * Bỏ khỏi menu chính / "Bảng tuỳ chỉnh" những mục đang nằm ở nhóm "Đã ghim" — mỗi tính năng hiện MỘT lần (#27).
 * Mục con đã ghim bị bỏ khỏi nhóm cha; nhóm cha hết con thì bỏ luôn. Rail thu gọn không hiện nhóm "Đã ghim"
 * nên nơi gọi truyền tập rỗng khi thu gọn.
 */
export function withoutPinned<T extends Pick<MenuItem, "key"> & { children?: readonly Pick<ChildMenuItem, "key">[] }>(
  items: readonly T[],
  pinned: ReadonlySet<string>,
): T[] {
  if (pinned.size === 0) return [...items]
  const out: T[] = []
  for (const item of items) {
    if (!item.children) {
      if (!pinned.has(item.key)) out.push(item)
      continue
    }
    const children = item.children.filter((c) => !pinned.has(c.key))
    if (children.length > 0) out.push(children.length === item.children.length ? item : { ...item, children })
  }
  return out
}
