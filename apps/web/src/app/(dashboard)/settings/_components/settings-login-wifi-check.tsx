"use client"

import { Loader2, Lock, ShieldCheck, ShieldOff } from "lucide-react"
import { toast } from "sonner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { usePermissions } from "@/lib/rbac"
import {
  useLoginWifiCheckConfig,
  useUpdateLoginWifiCheckConfig,
} from "@/hooks/use-login-wifi-check"
import { SettingsLoginWifiCheckTargets } from "./settings-login-wifi-check-targets"
import { errorMessage } from "@/lib/error-messages"

/**
 * Công tắc "Kiểm tra IP văn phòng khi
 * đăng nhập" trong Cài đặt, super_admin bật/tắt không cần redeploy.
 * - OFF (mặc định): đăng nhập KHÔNG kiểm tra IP — giữ nguyên hành vi hiện tại.
 * - ON: chặn đăng nhập nếu IP không khớp BẤT KỲ văn phòng nào đang hoạt động
 *   (KHÁC chấm công — chấm công vẫn match đúng 1 văn phòng được gán riêng).
 *   super_admin và danh sách bypass cấu hình qua env luôn được vào bất kể IP.
 * Chỉ người có quyền `settings.integrations` bật/tắt được; người khác xem read-only để biết đang ở chế độ nào.
 */
export function SettingsLoginWifiCheck() {
  // Quyền `settings.integrations` (khớp BE `login-wifi-check` PATCH).
  const canConfigure = usePermissions().can("settings.integrations")

  const { data, isLoading } = useLoginWifiCheckConfig()
  const updateMut = useUpdateLoginWifiCheckConfig()

  const enabled = data?.enabled ?? false
  const envForced = data?.envForced ?? false
  const effectiveEnabled = enabled || envForced

  const handleToggle = () => {
    if (!canConfigure || envForced) return
    const next = !enabled
    updateMut.mutate(next, {
      onSuccess: () => {
        toast.success(
          next
            ? "Đã BẬT kiểm tra IP văn phòng khi đăng nhập"
            : "Đã TẮT kiểm tra IP văn phòng khi đăng nhập",
        )
      },
      onError: (err) => toast.error(errorMessage(err, "Không lưu được, vui lòng thử lại")),
    })
  }

  return (
    <Card className="shadow-[0_4px_16px_rgba(0,0,0,0.06)] rounded-2xl">
      <CardHeader>
        <CardTitle>Đăng nhập theo Wifi văn phòng</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Đang tải cấu hình...
          </div>
        ) : (
          <button
            type="button"
            onClick={handleToggle}
            disabled={!canConfigure || envForced || updateMut.isPending}
            aria-pressed={effectiveEnabled}
            // viền mặc định --border (#e9eef6) trên thẻ trắng = 1,17:1.
            // Trạng thái TẮT dùng #7d8ba0 (3,46:1 trên trắng) như phương án đã chọn;
            // trạng thái BẬT trước đó dùng primary/40 cũng dưới 3:1 khi tự tính lại
            // (~1,73:1) nên nâng lên primary/80 (~3,26:1) để cả 2 trạng thái đều đạt
            // WCAG 1.4.11.
            className={cn(
              "flex w-full items-center justify-between rounded-xl border p-4 text-left transition-colors",
              effectiveEnabled
                ? "border-[var(--color-app-primary)]/80 bg-[var(--color-app-primary-soft)]/50"
                : "border-[#7d8ba0] bg-muted/30",
              (!canConfigure || envForced) && "cursor-default",
            )}
          >
            <span className="flex items-center gap-3">
              {updateMut.isPending ? (
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              ) : effectiveEnabled ? (
                <ShieldCheck className="size-5 text-[var(--color-app-primary-ink)]" />
              ) : (
                <ShieldOff className="size-5 text-muted-foreground" />
              )}
              <span>
                <span className="block text-sm font-semibold">
                  {effectiveEnabled
                    ? "Đang BẬT — chặn đăng nhập ngoài wifi văn phòng"
                    : "Đang TẮT — đăng nhập không kiểm tra IP"}
                </span>
                <span className="block text-xs text-muted-foreground">
                  Khi bật, những người/Team/Phòng ban trong danh sách áp dụng bên dưới chỉ đăng nhập được khi kết nối đúng IP của MỘT
                  trong các văn phòng công ty đang hoạt động. Danh
                  sách tài khoản được cấu hình bypass (vd tài khoản quản trị kỹ thuật) luôn đăng nhập
                  được bất kể IP. Chấm công KHÔNG bị ảnh hưởng bởi công tắc này.
                </span>
              </span>
            </span>
            <span
              className={cn(
                "text-xs font-semibold",
                effectiveEnabled ? "text-[var(--color-app-primary-ink)]" : "text-muted-foreground",
              )}
            >
              {effectiveEnabled ? "Bật" : "Tắt"}
            </span>
          </button>
        )}

        {envForced && !isLoading && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="size-3.5" />
            Đang bị ép BẬT bởi cấu hình máy chủ (biến môi trường) — công tắc
            Settings tạm thời không có tác dụng tắt.
          </p>
        )}
        {!canConfigure && !isLoading && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="size-3.5" />
            Bạn không có quyền bật/tắt cấu hình này.
          </p>
        )}

        {canConfigure && !isLoading && (
          <SettingsLoginWifiCheckTargets wifiCheckEnabled={effectiveEnabled} />
        )}
      </CardContent>
    </Card>
  )
}
