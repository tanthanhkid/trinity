import { ChevronDown } from "lucide-react"
import { SidebarGroup, SidebarGroupContent, SidebarMenu } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

/**
 * Một nhóm nghiệp vụ trên sidebar: tiêu đề nhỏ bấm để thu gọn/mở. Rail icon (64px) không có tiêu đề chữ —
 * hiện vạch phân cách và luôn hiện đủ mục (kể cả nhóm đang thu gọn) để không mất lối vào.
 */
export function ShellNavGroup({
  groupKey,
  title,
  collapsed,
  onToggle,
  children,
}: {
  groupKey: string
  title: string
  collapsed: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  const bodyId = `nav-group-${groupKey}`
  return (
    <SidebarGroup data-nav-group={groupKey} data-collapsed={collapsed ? "" : undefined}>
      <button
        type="button"
        className="app-nav-group-head group-data-[collapsible=icon]:hidden"
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        <span>{title}</span>
        <ChevronDown className="app-nav-group-chev" aria-hidden />
      </button>
      <div className="app-nav-group-rule hidden group-data-[collapsible=icon]:block" aria-hidden />
      <SidebarGroupContent
        id={bodyId}
        className={cn(collapsed && "hidden group-data-[collapsible=icon]:block")}
      >
        <SidebarMenu>{children}</SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
