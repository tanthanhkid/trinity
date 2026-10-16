"use client"

import { Suspense, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import dynamic from "next/dynamic"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import {
  User,
  Users,
  Shield,
  Bell,
  ChevronRight,
  ArrowLeft,
  Tag,
  KeyRound,
  ChevronDown,
  Building2,
  Users2,
  Wifi,
  ToggleRight,
  PlugZap,
  Sparkles,
  Newspaper,
} from "lucide-react"
import type { OrgFeatureKey, OrgFeatures, Permission } from "@trinity/rbac"
import { usePermissions } from "@/lib/rbac"
import { useOrgFeatures } from "@/hooks/use-org-features"
import { useSetupStatus } from "@/hooks/use-setup-status"
import { SETUP_SETTINGS_TABS } from "@/lib/setup-routes"
import { cn } from "@/lib/utils"
import { SettingsSectionHeader } from "./_components/settings-section-header"

/** Cuộn lên đầu: vùng cuộn thật là `<main>` (overflow-auto) hoặc window tuỳ layout. */
function scrollToTop() {
  if (typeof window === "undefined") return
  window.scrollTo(0, 0)
  document.querySelector("main")?.scrollTo(0, 0)
}

const TabSkeleton = () => <Skeleton className="h-64 w-full rounded-2xl mt-4" />

const SettingsProfile = dynamic(
  () => import("./_components/settings-profile").then((m) => ({ default: m.SettingsProfile })),
  { loading: TabSkeleton },
)
const SettingsUsers = dynamic(
  () => import("./_components/settings-users").then((m) => ({ default: m.SettingsUsers })),
  { loading: TabSkeleton },
)
const SettingsRoles = dynamic(
  () => import("./_components/roles/roles-page").then((m) => ({ default: m.RolesPage })),
  { loading: TabSkeleton },
)
const SettingsNotifications = dynamic(
  () => import("./_components/settings-notifications").then((m) => ({ default: m.SettingsNotifications })),
  { loading: TabSkeleton },
)
const SettingsDepartments = dynamic(
  () => import("./_components/settings-departments").then((m) => ({ default: m.SettingsDepartments })),
  { loading: TabSkeleton },
)
const SettingsTeams = dynamic(
  () => import("./_components/settings-teams").then((m) => ({ default: m.SettingsTeams })),
  { loading: TabSkeleton },
)
const SettingsCustomerLists = dynamic(
  () => import("./_components/settings-customer-lists").then((m) => ({ default: m.SettingsCustomerLists })),
  { loading: TabSkeleton },
)
const SettingsApiKeys = dynamic(
  () =>
    import("./_components/settings-api-keys").then((m) => ({
      default: m.SettingsApiKeys,
    })),
  { loading: TabSkeleton },
)


const SettingsLoginWifiCheck = dynamic(
  () =>
    import("./_components/settings-login-wifi-check").then((m) => ({
      default: m.SettingsLoginWifiCheck,
    })),
  { loading: TabSkeleton },
)

const SettingsFeatures = dynamic(
  () => import("./_components/settings-features").then((m) => ({ default: m.SettingsFeatures })),
  { loading: TabSkeleton },
)

const SettingsSalesAssistant = dynamic(
  () => import("./_components/settings-sales-assistant").then((m) => ({ default: m.SettingsSalesAssistant })),
  { loading: TabSkeleton },
)

const SettingsBriefings = dynamic(
  () => import("./_components/settings-briefings").then((m) => ({ default: m.SettingsBriefings })),
  { loading: TabSkeleton },
)

const SettingsIntegrations = dynamic(
  () => import("./_components/settings-integrations").then((m) => ({ default: m.SettingsIntegrations })),
  { loading: TabSkeleton },
)

// Exported để test đọc trực tiếp permission từng tab mà không cần render component client.
// RBAC theo quyền + phạm vi — `permission`/`anyOf` quyết định tab nào hiện. Không khai gì
// (cả 2 field `undefined`) = mở cho MỌI người đã đăng nhập (`@AuthOnly`, vd "Hồ sơ cá nhân"/
// "Thông báo"). Bảng map: users→`users.view` · roles→`roles.manage` ·
// departments/job-titles/teams→`org.manage` · contact-sources/stages/statuses (cùng
// nhóm catalog)→`contacts.catalog` · api-keys/wifi→`settings.integrations` ·
// projects (Dự án)→`products.manage`.
export const ALL_TABS = [
  { value: "profile", label: "Hồ sơ cá nhân", icon: User, description: "Thông tin tài khoản, mật khẩu" },
  { value: "users", label: "Người dùng", icon: Users, description: "Quản lý tài khoản nhân viên", permission: "users.view" as Permission },
  { value: "roles", label: "Vai trò", icon: Shield, description: "Phân quyền hệ thống", permission: "roles.manage" as Permission },
  { value: "departments", label: "Phòng ban", icon: Building2, description: "Danh sách phòng ban dùng chung cho NV, hợp đồng, tuyển dụng", permission: "org.manage" as Permission, feature: "management" as OrgFeatureKey },
  { value: "teams", label: "Team", icon: Users2, description: "Cấu hình Team (1 phòng ban nhiều team) + trưởng nhóm; gán NV vào Team tự set trưởng nhóm + phòng ban", permission: "org.manage" as Permission, feature: "management" as OrgFeatureKey },
  { value: "customer-lists", label: "Danh mục khách hàng", icon: Tag, description: "Nguồn khách, giai đoạn và trạng thái chăm sóc: tự đặt theo cách công ty bạn làm việc", permission: "contacts.catalog" as Permission, feature: "contacts" as OrgFeatureKey },
  { value: "sales-assistant", label: "Trợ lý bán hàng", icon: Sparkles, description: "Quy tắc chấm điểm khách tiềm năng và ngưỡng nhắc việc treo", permission: "contacts.catalog" as Permission, feature: "contacts" as OrgFeatureKey },
  { value: "api-keys", label: "Khoá API bên thứ 3", icon: KeyRound, description: "Cấp khoá cho landing page / đối tác tạo khách hàng", permission: "settings.integrations" as Permission },
  { value: "features", label: "Tính năng", icon: ToggleRight, description: "Bật/tắt từng chức năng (menu, báo cáo...) cho toàn công ty — độc lập với phân quyền", permission: "settings.features" as Permission },
  // khung "Kết nối & AI" — hiện với người có BẤT KỲ quyền nào trong nhóm (`anyOf`); từng mục con
  // lọc tiếp theo quyền riêng + cờ máy chủ (xem settings-integrations.tsx). `feature` = công tắc tổ chức "integrations".
  { value: "integrations", label: "Kết nối & AI", icon: PlugZap, description: "Webhook ra/vào, kết nối ChatGPT/Claude, Zalo OA và nhật ký tích hợp", anyOf: ["integrations.webhooks", "integrations.ai_connect", "integrations.ai_admin", "contacts.update"] as readonly Permission[], feature: "integrations" as OrgFeatureKey },
  { value: "briefings", label: "Bản tin sáng/chiều", icon: Newspaper, description: "Bản tin số liệu tự động gửi trong app; trợ lý AI của bạn có thể viết thay", permission: "settings.integrations" as Permission, feature: "ai_briefing" as OrgFeatureKey },
  { value: "login-wifi-check", label: "Đăng nhập theo Wifi văn phòng", icon: Wifi, description: "Bật/tắt kiểm tra IP văn phòng khi đăng nhập", permission: "settings.integrations" as Permission, feature: "attendance" as OrgFeatureKey },
  { value: "notifications", label: "Thông báo", icon: Bell, description: "Cài đặt thông báo" },
] as const

type TabValue = (typeof ALL_TABS)[number]["value"]

// Nhóm các tab theo chủ đề để sidebar dọc gọn gàng
// Exported để test khoá việc 1 tab bị gỡ khỏi nav mà không cần render component client.
export const TAB_GROUPS = [
  {
    label: "Tính năng & Kết nối",
    tabs: ["features", "integrations", "api-keys", "briefings"],
  },
  {
    label: "Khách hàng",
    tabs: ["customer-lists", "sales-assistant"],
  },
  {
    label: "Công ty & Nhân sự",
    tabs: ["users", "roles", "departments", "teams", "login-wifi-check"],
  },
  {
    label: "Cá nhân",
    tabs: ["profile", "notifications"],
  },
] as const

const tabComponents: Record<TabValue, React.ComponentType> = {
  profile: SettingsProfile,
  users: SettingsUsers,
  roles: SettingsRoles,
  departments: SettingsDepartments,
  teams: SettingsTeams,
  "customer-lists": SettingsCustomerLists,
  "sales-assistant": SettingsSalesAssistant,
  "api-keys": SettingsApiKeys,
  "login-wifi-check": SettingsLoginWifiCheck,
  features: SettingsFeatures,
  integrations: SettingsIntegrations,
  briefings: SettingsBriefings,
  notifications: SettingsNotifications,
}

/**
 * Tab có được hiện không: `permission` (1 quyền) → `anyOf` (có ÍT NHẤT một) → không khai gì = mở cho mọi người đã
 * đăng nhập; `feature` (nếu có) = công tắc tổ chức — tắt thì ẩn tab với MỌI người. Exported để test khoá đúng logic
 * đang chạy (không mirror lại trong test).
 */
export function isSettingsTabVisible(
  t: (typeof ALL_TABS)[number],
  can: (p: Permission) => boolean,
  features?: OrgFeatures,
): boolean {
  if ("hidden" in t && t.hidden) return false
  if ("feature" in t && features && features[t.feature] === false) return false
  if ("permission" in t) return can(t.permission)
  if ("anyOf" in t) return t.anyOf.some((p) => can(p))
  return true
}

/** Mục đã gộp hoặc bỏ → mục thay thế. */
const LEGACY_TAB_ALIASES: Record<string, TabValue> = {
  "contact-sources": "customer-lists",
  "contact-stages": "customer-lists",
  "contact-statuses": "customer-lists",
}

function isValidTabValue(value: string): value is TabValue {
  return ALL_TABS.some((t) => t.value === value)
}

function SettingsPageContent() {
  const searchParams = useSearchParams()
  const { can } = usePermissions()
  const { features } = useOrgFeatures()

  // Không khai `permission`/`anyOf` → mở cho mọi người đã đăng nhập (vd "Hồ sơ cá nhân", "Thông báo").
  // hệ thống chưa dựng quy trình ⇒ Cài đặt tối giản (tài khoản, người dùng, vai trò, team, kết nối AI, thông báo).
  const { status: setupStatus } = useSetupStatus()
  const settingsTabs = ALL_TABS.filter(
    (t) => isSettingsTabVisible(t, can, features) && (setupStatus !== "chua_dung" || (SETUP_SETTINGS_TABS as readonly string[]).includes(t.value)),
  )

  // Mục cũ đã gộp: link cũ (?tab=contact-sources…) vẫn mở đúng chỗ mới.
  const rawTab = searchParams.get("tab")
  const tabParam = rawTab && rawTab in LEGACY_TAB_ALIASES ? LEGACY_TAB_ALIASES[rawTab] : rawTab
  // Chỉ dùng tabParam nếu tồn tại trong settingsTabs (subset RBAC) — không kiểm tra ALL_TABS
  // để tránh non-super_admin deep-link vào tab không có quyền → blank content / API 403.
  const validTabParam =
    tabParam && isValidTabValue(tabParam) && settingsTabs.some((t) => t.value === tabParam)
      ? tabParam
      : null
  const initialTab = validTabParam ?? "profile"

  const router = useRouter()
  const [activeTab, setActiveTab] = useState<TabValue>(initialTab)
  const [mobileTab, setMobileTab] = useState<TabValue | null>(validTabParam)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    // Mở sẵn nhóm chứa tab đang active
    const group = TAB_GROUPS.find((g) => g.tabs.includes(initialTab as never))
    return new Set(group ? [group.label] : [TAB_GROUPS[0].label])
  })

  // Cho phép nội dung 1 tab  deep-link SANG tab khác bằng <Link href="/settings?tab=...">
  // NGAY TRONG cùng trang — `activeTab` chỉ khởi tạo 1 LẦN từ `initialTab` lúc
  // mount (useState), tab click qua `handleSelectTab` KHÔNG ghi URL nên effect
  // này không tự fire khi user bấm tab thủ công (searchParams không đổi).
  // Điện thoại: `mobileTab` bám URL (`?tab=` = đang ở một mục, không có = danh sách)
  // nên Link nội bộ + nút Back của trình duyệt đều đổi mục đúng; mở/đóng mục cuộn lên đầu.
  useEffect(() => {
    setMobileTab(validTabParam)
    scrollToTop()
    if (validTabParam && validTabParam !== activeTab) {
      setActiveTab(validTabParam)
      const group = TAB_GROUPS.find((g) => g.tabs.includes(validTabParam as never))
      if (group) {
        setExpandedGroups((prev) => (prev.has(group.label) ? prev : new Set(prev).add(group.label)))
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validTabParam])

  const activeTabMeta = settingsTabs.find((t) => t.value === activeTab)
  const ActiveComponent = tabComponents[activeTab]

  const activeMobileMeta = mobileTab ? settingsTabs.find((t) => t.value === mobileTab) : null
  const activeMobileLabel = activeMobileMeta?.label ?? null
  const ActiveMobileComponent = mobileTab ? tabComponents[mobileTab] : null

  function toggleGroup(label: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(label)) {
        next.delete(label)
      } else {
        next.add(label)
      }
      return next
    })
  }

  function openMobileTab(value: TabValue | null) {
    router.push(value ? `/settings?tab=${value}` : "/settings")
  }

  function handleSelectTab(value: TabValue) {
    setActiveTab(value)
    // Đảm bảo nhóm chứa tab được mở
    const group = TAB_GROUPS.find((g) => g.tabs.includes(value as never))
    if (group) {
      setExpandedGroups((prev) => {
        if (prev.has(group.label)) return prev
        const next = new Set(prev)
        next.add(group.label)
        return next
      })
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-[22px] font-semibold leading-tight tracking-tight text-foreground max-sm:sr-only">Cài đặt</h1>

      {/* Desktop: sidebar dọc bên trái + nội dung bên phải */}
      <div className="hidden md:flex gap-6 items-start">
        {/* Sidebar nhóm */}
        <nav aria-label="Mục cài đặt" className="w-60 shrink-0 overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-card p-1.5 shadow-[var(--shadow-card)]">
          {TAB_GROUPS.map((group) => {
            const groupTabs = group.tabs
              .map((v) => settingsTabs.find((t) => t.value === v))
              .filter(Boolean) as (typeof settingsTabs)[number][]

            if (groupTabs.length === 0) return null

            const isOpen = expandedGroups.has(group.label)
            const hasActive = groupTabs.some((t) => t.value === activeTab)

            return (
              <div key={group.label} className="pb-1 last:pb-0">
                {/* Header nhóm */}
                <button
                  onClick={() => toggleGroup(group.label)}
                  className={cn(
                    "flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[var(--muted)]",
                  )}
                >
                  <span
                    className={cn(
                      "text-sm font-medium",
                      hasActive ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {group.label}
                  </span>
                  <ChevronDown
                    className={cn(
                      "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
                      isOpen && "rotate-180",
                    )}
                  />
                </button>

                {/* Danh sách tab trong nhóm */}
                {isOpen && (
                  <ul className="space-y-0.5 pb-1">
                    {groupTabs.map((tab) => {
                      const isActive = tab.value === activeTab
                      return (
                        <li key={tab.value}>
                          <button
                            onClick={() => handleSelectTab(tab.value)}
                            className={cn(
                              "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                              isActive
                                ? "bg-[var(--muted)] font-medium text-foreground"
                                : "text-[var(--color-app-ink-2)] hover:bg-[var(--muted)] hover:text-foreground",
                            )}
                          >
                            <tab.icon className={cn("size-4 shrink-0", isActive ? "text-foreground" : "text-muted-foreground")} />
                            <span className="truncate">{tab.label}</span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            )
          })}
        </nav>

        {/* Nội dung tab */}
        <div className="flex-1 min-w-0">
          {activeTabMeta ? (
            <SettingsSectionHeader
              key={activeTabMeta.value}
              icon={activeTabMeta.icon}
              title={activeTabMeta.label}
              description={activeTabMeta.description}
            >
              <ActiveComponent />
            </SettingsSectionHeader>
          ) : (
            <ActiveComponent />
          )}
        </div>
      </div>

      {/* Mobile: menu list → detail pattern (giữ nguyên) */}
      <div className="md:hidden">
        {mobileTab === null ? (
          <div className="space-y-3">
            {TAB_GROUPS.map((group) => {
              const groupTabs = group.tabs
                .map((v) => settingsTabs.find((t) => t.value === v))
                .filter(Boolean) as (typeof settingsTabs)[number][]

              if (groupTabs.length === 0) return null

              return (
                <div key={group.label}>
                  <p className="mb-1.5 px-1 text-sm font-medium text-muted-foreground">{group.label}</p>
                  <div className="space-y-1.5">
                    {groupTabs.map((tab) => (
                      <button
                        key={tab.value}
                        onClick={() => openMobileTab(tab.value)}
                        // Giao diện mới: thẻ viền 1px `--border` như mọi khung `.box` của bản demo.
                        className="flex w-full items-center gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-card p-3.5 text-left shadow-[var(--shadow-card)] transition-colors active:bg-muted"
                      >
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--muted)] text-foreground">
                          <tab.icon className="size-5" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold">{tab.label}</p>
                          <p className="line-clamp-2 text-xs text-muted-foreground">{tab.description}</p>
                        </div>
                        <ChevronRight className="size-5 shrink-0 text-muted-foreground" />
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div>
            <Button
              type="button"
              variant="ghost"
              aria-label="Quay lại danh sách cài đặt"
              onClick={() => openMobileTab(null)}
              className="mb-2 -ml-2 text-[var(--color-app-primary-ink)]"
            >
              <ArrowLeft className="size-4" />
              Quay lại
            </Button>
            {ActiveMobileComponent && (
              <SettingsSectionHeader
                key={mobileTab}
                icon={activeMobileMeta?.icon}
                title={activeMobileLabel ?? ""}
                description={activeMobileMeta?.description}
              >
                <ActiveMobileComponent />
              </SettingsSectionHeader>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full rounded-2xl" />}>
      <SettingsPageContent />
    </Suspense>
  )
}
