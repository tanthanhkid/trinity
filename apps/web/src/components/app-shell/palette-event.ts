/**
 * Sự kiện cửa sổ "mở bảng tìm nhanh" (⌘K). Ô tìm kiếm ở thanh trên bắn sự kiện
 * này; `ShellQuickActions` (sidebar) là NƠI DUY NHẤT giữ trạng thái + dựng
 * `ShellCommandPalette` nên lắng nghe và mở — không nhân đôi bảng tìm, không
 * dựng API tìm kiếm mới.
 */
export const OPEN_PALETTE_EVENT = "trinity:open-command-palette"

export function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_PALETTE_EVENT))
}
