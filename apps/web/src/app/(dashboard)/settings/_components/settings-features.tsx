"use client"

import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { ORG_FEATURES, ORG_FEATURE_KEYS } from "@trinity/rbac"
import type { OrgFeatureKey } from "@trinity/rbac"
import { Card, CardContent } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { useOrgFeatures, useUpdateOrgFeatures } from "@/hooks/use-org-features"
import { usePermissions } from "@/lib/rbac"
import { SettingsPlanUsage } from "./settings-plan-usage"
import { CustomObjectsSection } from "./custom-objects/custom-objects-section"

/**
 * Cài đặt > Tính năng — bật/tắt từng module THEO TỔ CHỨC. Tắt =
 * ẩn khỏi menu + chặn vào thẳng URL với MỌI người (kể cả Quản trị, người chỉ
 * còn thấy Cài đặt để bật lại). KHÔNG phải phân quyền: ai được làm gì vẫn do
 * "Vai trò". Mặc định bật hết. Tab này chỉ hiện với quyền `settings.features`.
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
        onError: () => toast.error("Không lưu được, vui lòng thử lại"),
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
        Tắt một tính năng sẽ ẩn nó với <strong>mọi người</strong> trong công ty (menu,
        số liệu, và chặn truy cập trực tiếp). Quyền của từng người vẫn do mục “Vai trò” quyết định.
        Mặc định mọi tính năng đều bật.
      </p>
      <Card className="rounded-2xl shadow-[0_4px_16px_rgba(0,0,0,0.06)]">
        <CardContent className="divide-y p-0">
          {ORG_FEATURE_KEYS.map((key) => {
            const { label, description } = ORG_FEATURES[key]
            const lockedReason = locked[key]
            return (
              <label key={key} htmlFor={`feature-switch-${key}`} className="flex items-center justify-between gap-4 px-5 py-4 max-sm:min-h-14 max-sm:cursor-pointer">
                <div className="min-w-0">
                  <p id={`feature-${key}`} className="font-medium">{label}</p>
                  <p className="text-sm text-muted-foreground">{description}</p>
                  {lockedReason && (
                    <p className="mt-1 text-xs text-amber-600">{lockedReason}</p>
                  )}
                </div>
                <Switch
                  checked={features[key]}
                  disabled={update.isPending || Boolean(lockedReason)}
                  onCheckedChange={(v) => toggle(key, v)}
                  aria-labelledby={`feature-${key}`}
                  id={`feature-switch-${key}`}
                />
              </label>
            )
          })}
        </CardContent>
      </Card>
      {can("custom_objects.manage") && (
        <div className="border-t pt-6">
          <CustomObjectsSection />
        </div>
      )}
    </div>
  )
}
