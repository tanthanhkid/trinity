"use client"

import { useMemo, useState } from "react"
import { usePathname } from "next/navigation"
import Link from "next/link"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { menuItems } from "@/components/nav-config"
import {
  withExtraMenuItems,
} from "@/components/app-shell/menu-extra"
import { CUSTOM_ITEM_KEY_PREFIX, withCustomObjectItems } from "@/components/app-shell/menu-custom"
import { useCustomNav } from "@/hooks/custom-objects/use-custom-objects"
import { isItemVisible, isChildVisible } from "@/components/nav-visibility"
import { ShellGroupItem, ShellLeafItem } from "@/components/app-shell/sidebar-items"
import { ShellWorkspaceHeader } from "@/components/app-shell/workspace-header"
import { ShellQuickActions } from "@/components/app-shell/sidebar-quick-actions"
import { ShellPinnedGroup } from "@/components/app-shell/sidebar-pinned-group"
import { ShellRecentGroup } from "@/components/app-shell/sidebar-recent-group"
import { ShellGroupLabel } from "@/components/app-shell/sidebar-group-label"
import { ShellSidebarUser } from "@/components/app-shell/sidebar-user"
import { collectMenuHrefs, isItemActive, resolveActiveHref } from "@/components/app-shell/nav-active"
import { resolvePinnedEntries, withoutPinned, type FlatMenuEntry } from "@/components/app-shell/menu-resolve"
import { usePinnedMenus } from "@/hooks/use-pinned-menus"
import { useRecentContacts } from "@/hooks/use-recent-contacts"
import { useOrgFeatures } from "@/hooks/use-org-features"
import { useSetupStatus } from "@/hooks/use-setup-status"
import { withSetupMenu } from "@/components/app-shell/menu-setup"
import { usePermissions } from "@/lib/rbac"
import { cn } from "@/lib/utils"

/**
 * Sidebar theo demo giao diện mới (`trinity-giao-dien-demo`): nền panel, viền 1px.
 * Bố cục từ trên xuống: logo + "Trinity" → ô "Tìm hoặc ra lệnh ⌘K" → menu chính
 * (có số đếm khi app có sẵn dữ liệu, vd đề xuất AI chờ duyệt) → Bảng tuỳ chỉnh →
 * Đã ghim → Khách gần đây → chân: Cài đặt + người dùng + nút sáng/tối.
 *
 * 🔴 RBAC: menu lọc qua ĐÚNG `nav-config.ts` + `nav-visibility.ts` — nguồn
 * RBAC DUY NHẤT, KHÔNG có đường tắt nào khác (kể cả nhóm ĐÃ GHIM/KHÁCH GẦN
 * ĐÂY mới thêm — xem `menu-resolve.ts` § `resolvePinnedEntries` và
 * `hooks/use-recent-contacts.ts`).
 */
export function ShellSidebar() {
  const pathname = usePathname() ?? ""
  const { grants, can } = usePermissions()
  const { setOpenMobile, setOpen, state, isMobile } = useSidebar()
  // Compact (rail 64px) chỉ có trên desktop — mobile là drawer Sheet, không thu gọn.
  const compact = state === "collapsed" && !isMobile

  // `withExtraMenuItems` CHẠY TRƯỚC
  // lọc RBAC — mọi mục (kể cả mục gộp/mục chèn thêm) đi qua ĐÚNG 1 bộ luật
  // hiển thị (`permissions`), không có đường tắt.
  // Các mục tuỳ biến cấp 1 lấy từ BE (đã lọc theo vai trò); chỉ gọi khi có quyền xem dữ liệu tuỳ biến (tránh 403 thừa).
  const { data: customNav } = useCustomNav(can("custom_records.view"))
  // chưa dựng quy trình ⇒ chỉ Bắt đầu · Hoạt động AI · Cài đặt; đang dựng ⇒ thêm "Bắt đầu" lên đầu.
  const { status: setupStatus } = useSetupStatus()
  const blank = setupStatus === "chua_dung"
  const baseItems = useMemo(
    () => withSetupMenu(withCustomObjectItems(withExtraMenuItems(menuItems), customNav ?? []), setupStatus),
    [customNav, setupStatus],
  )
  const { features, isLoading: featuresLoading } = useOrgFeatures()
  // Lần tải đầu: chưa biết tính năng nào bật ⇒ tạm ẩn mục có công tắc (tránh menu đầy đủ nháy rồi thu gọn).
  // Tải xong hoặc lỗi ⇒ luật cũ (lỗi = fail-open, bật hết).
  const visibleItems = useMemo(
    () => baseItems.filter((item) => !(featuresLoading && item.feature) && isItemVisible(item, grants, features)),
    [baseItems, grants, features, featuresLoading],
  )

  // Trạng thái "đang sáng" tính TẬP TRUNG 1 lần cho cả menu — href khớp DÀI
  // NHẤT thắng (tránh 2 mục cùng sáng khi 1 href là tiền tố của href khác).
  const activeHref = useMemo(() => {
    const hrefs = collectMenuHrefs(visibleItems, (item) =>
      (item.children ?? []).filter((child) => isChildVisible(child, grants)),
    )
    return resolveActiveHref(pathname, hrefs)
  }, [visibleItems, grants, pathname])

  // Danh sách phẳng (leaf + children) đã lọc RBAC — nguồn DUY NHẤT cho nhóm
  // "ĐÃ GHIM" (resolvePinnedEntries) và tìm-điều-hướng trong command palette.
  // Mục ghim không còn trong danh sách này (đổi quyền, permission ẩn...) tự
  // biến mất — không cần lớp RBAC riêng ở 2 nơi tiêu thụ đó.
  const visibleFlatEntries = useMemo<FlatMenuEntry[]>(() => {
    const out: FlatMenuEntry[] = []
    for (const item of visibleItems) {
      if (item.external) continue
      if (item.children) {
        for (const child of item.children) {
          if (!child.href) continue
          if (!isChildVisible(child, grants)) continue
          out.push({ key: child.key, title: child.title, icon: child.icon, href: child.href })
        }
        continue
      }
      if (!item.href) continue
      out.push({ key: item.key, title: item.title, icon: item.icon, href: item.href, badgeLabel: item.badgeLabel })
    }
    return out
  }, [visibleItems, grants])

  const { pinnedKeys, isPinned, togglePin } = usePinnedMenus()
  const { recentContacts } = useRecentContacts()

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const closeMobile = () => setOpenMobile(false)
  // Compact: mục con KHÔNG hiện trong rail 64px ⇒ bấm mục cha thì mở rộng
  // sidebar và bung đúng nhóm đó, thay vì bung ra chỗ không thấy.
  const onGroupToggle = (key: string) => {
    if (compact) {
      setOpen(true)
      setExpanded((prev) => new Set(prev).add(key))
      return
    }
    toggle(key)
  }

  // "Cài đặt" ghim cố định ở chân sidebar; mục "tính năng tuỳ biến" (key `custom_…`,
  // xem `menu-custom.ts`) gom thành nhóm "Bảng tuỳ chỉnh" riêng như demo.
  // Mục đã ở nhóm "Đã ghim" thì không lặp lại ở menu chính / "Bảng tuỳ chỉnh" (#27); rail thu gọn không có nhóm ghim nên giữ đủ.
  const pinnedShown = useMemo(
    () => new Set(compact || blank ? [] : resolvePinnedEntries(pinnedKeys, visibleFlatEntries).map((e) => e.key)),
    [compact, blank, pinnedKeys, visibleFlatEntries],
  )
  const settingsItem = visibleItems.find((item) => item.key === "settings")
  const listedItems = withoutPinned(visibleItems, pinnedShown)
  const mainItems = listedItems.filter(
    (item) => item.key !== "settings" && !item.key.startsWith(CUSTOM_ITEM_KEY_PREFIX),
  )
  const customItems = listedItems.filter((item) => item.key.startsWith(CUSTOM_ITEM_KEY_PREFIX))

  const renderItem = (item: (typeof visibleItems)[number]) =>
    item.children ? (
      <ShellGroupItem
        key={item.key}
        item={item as typeof item & { children: NonNullable<typeof item.children> }}
        activeHref={activeHref}
        grants={grants}
        isExpanded={expanded.has(item.key)}
        onToggle={() => onGroupToggle(item.key)}
        onNavigate={closeMobile}
        isChildPinned={isPinned}
        onToggleChildPin={togglePin}
      />
    ) : (
      <ShellLeafItem
        key={item.key}
        item={item}
        activeHref={activeHref}
        onNavigate={closeMobile}
        isPinned={isPinned(item.key)}
        onTogglePin={() => togglePin(item.key)}
      />
    )

  return (
    <Sidebar collapsible="icon" className="border-none">
      <SidebarHeader>
        <ShellWorkspaceHeader />
        {!blank && <ShellQuickActions navEntries={visibleFlatEntries} />}
      </SidebarHeader>

      <SidebarContent className="group-data-[collapsible=icon]:overflow-auto">
        {!blank && <ShellPinnedGroup
          pinnedKeys={pinnedKeys}
          visibleFlatEntries={visibleFlatEntries}
          activeHref={activeHref}
          onTogglePin={togglePin}
          onNavigate={closeMobile}
        />}

        {/* Menu chính — luôn hiện cả ở rail thu gọn (chỉ icon). */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>{mainItems.map(renderItem)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {customItems.length > 0 && (
          <SidebarGroup>
            <ShellGroupLabel>Bảng tuỳ chỉnh</ShellGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>{customItems.map(renderItem)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {!blank && <ShellRecentGroup contacts={recentContacts} onNavigate={closeMobile} />}
      </SidebarContent>

      {/* Chân: "Cài đặt" (ngoài vùng cuộn, KHÔNG tham gia ghim) + người dùng + nút sáng/tối. */}
      <SidebarFooter>
        {settingsItem?.href && (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                render={<Link href={settingsItem.href} onClick={closeMobile} />}
                isActive={isItemActive(activeHref, settingsItem.href)}
                tooltip={settingsItem.title}
                className={cn(isItemActive(activeHref, settingsItem.href) && "app-nav-active")}
              >
                <settingsItem.icon />
                <span className="truncate">{settingsItem.title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        )}
        <ShellSidebarUser />
      </SidebarFooter>
    </Sidebar>
  )
}
