"use client"

import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { BASIC_FEATURES, ORG_FEATURE_GROUPS, ORG_FEATURES, ORG_FEATURE_KEYS } from "@trinity/rbac"
import type { OrgFeatureKey } from "@trinity/rbac"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { Switch } from "@/components/ui/switch"
import { useOrgFeatures, useUpdateOrgFeatures } from "@/hooks/use-org-features"
import { usePermissions } from "@/lib/rbac"
import { SettingsPlanUsage } from "./settings-plan-usage"
import { CustomObjectsSection } from "./custom-objects/custom-objects-section"
import { errorMessage } from "@/lib/error-messages"

/**
 * Cài đặt > Tính năng — bật/tắt từng module THEO TỔ CHỨC. Tắt =
 * ẩn khỏi menu + chặn vào thẳng URL với MỌI người (kể cả Quản trị, người chỉ
 * còn thấy Cài đặt để bật lại). KHÔNG phải phân quyền: ai được làm gì vẫn do
 * "Vai trò". Nơi DUY NHẤT bật/tắt module: menu và mục Cài đặt con chỉ hiện khi tính năng bật.
 * Chia theo nhóm (`ORG_FEATURE_GROUPS`). Tab này chỉ hiện với quyền `settings.features`.
 */
export function SettingsFeatures() {
  const { features, isLoading, locked = {} } = useOrgFeatures()
  const update = useUpdateOrgFeatures()
  const { can } = usePermissions()

  const toggle = (key: OrgFeatureKey, next: boolean) => {
    update.mutate(
      { [key]: next },
      {
        onSuccess: () =>
          toast.success(`Đã ${next ? "BẬT" : "TẮT"} “${ORG_FEATURES[key].label}”`),
        onError: (err) => toast.error(errorMessage(err, "Không lưu được, vui lòng thử lại")),
      },
    )
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Đang tải cấu hình...
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <SettingsPlanUsage />
      <p className="text-sm text-muted-foreground">
        Bật tính năng nào thì tính năng đó mới hiện ở menu. Tắt thì ẩn với <strong>mọi người</strong> trong công ty,
        dữ liệu vẫn giữ nguyên, bật lại là thấy. Quyền của từng người vẫn do mục “Vai trò” quyết định.
      </p>
      {ORG_FEATURE_GROUPS.map((group) => {
        const keys = ORG_FEATURE_KEYS.filter((k) => ORG_FEATURES[k].group === group.key)
        const on = keys.filter((k) => features[k]).length
        return (
          <section key={group.key} aria-labelledby={`feature-group-${group.key}`} className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <h3 id={`feature-group-${group.key}`} className="text-sm font-semibold">{group.label}</h3>
              <span className="text-xs text-muted-foreground">Đang bật {on}/{keys.length}</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {keys.map((key) => {
                const { label, description } = ORG_FEATURES[key]
                const lockedReason = locked[key]
                const basic = (BASIC_FEATURES as readonly string[]).includes(key)
                return (
                  <Card key={key} className={cn("rounded-2xl shadow-none transition-colors", features[key] && "border-[var(--ring)]/40 bg-[var(--accent)]/30")}>
                    <CardContent className="p-0">
                      <label htmlFor={`feature-switch-${key}`} className="flex min-h-16 cursor-pointer items-start justify-between gap-4 px-4 py-3.5">
                        <div className="min-w-0">
                          <p className="font-medium">
                            <span id={`feature-${key}`}>{label}</span>
                            {basic && <span className="ml-2 rounded-full bg-muted px-2 py-0.5 align-middle text-[11px] font-normal text-muted-foreground">Cơ bản</span>}
                          </p>
                          <p className="text-sm text-muted-foreground">{description}</p>
                          {lockedReason && <p className="mt-1 text-xs text-amber-600">{lockedReason}</p>}
                        </div>
                        <Switch
                          checked={features[key]}
                          disabled={update.isPending || Boolean(lockedReason)}
                          onCheckedChange={(v) => toggle(key, v)}
                          aria-labelledby={`feature-${key}`}
                          id={`feature-switch-${key}`}
                          className="mt-0.5"
                        />
                      </label>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          </section>
        )
      })}
      {can("custom_objects.manage") && (
        <div className="border-t pt-6">
          <CustomObjectsSection />
        </div>
      )}
    </div>
  )
}
