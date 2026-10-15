"use client"

import { SettingsSectionActions } from "./settings-section-header"
import { useEffect, useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Bell, BellOff, Volume2, Check, Loader2, Save, Lock } from "lucide-react"
import { toast } from "sonner"
import apiClient from "@/lib/api-client"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { usePermissions } from "@/lib/rbac"
import { useNotificationSound } from "@/hooks/use-notification-sound"
import {
  NOTIFICATION_SOUNDS,
  setNotificationSoundId,
  DEFAULT_SOUND_ID,
} from "@/lib/notification-sounds"

const SOUND_QUERY_KEY = ["settings", "notification-sound"] as const

/**
 * Card âm báo thông báo CHUNG toàn hệ thống (+ yêu cầu super_admin
 * chọn áp dụng cho cả dự án).
 * - super_admin: chọn âm → bấm "Lưu" → PATCH /settings/notification-sound →
 *   áp dụng cho MỌI nhân viên.
 * - Role khác: xem âm chung (read-only) + nghe thử; KHÔNG đổi được.
 * - Bật/tắt âm (mute) vẫn là cài đặt RIÊNG mỗi người (localStorage).
 */
export function SettingsNotificationSound() {
  // BE `PATCH /settings/notification-sound` = `settings.integrations`.
  const canConfigure = usePermissions().can("settings.integrations")
  const qc = useQueryClient()
  const { previewSound, isSoundEnabled, toggleSound } = useNotificationSound()

  const [enabled, setEnabled] = useState(true)
  const [pendingId, setPendingId] = useState<string | null>(null)

  const { data } = useQuery({
    queryKey: SOUND_QUERY_KEY,
    queryFn: async () =>
      (await apiClient.get<{ sound_id: string }>("/settings/notification-sound")).data,
    staleTime: 60_000,
  })
  const savedId = data?.sound_id ?? DEFAULT_SOUND_ID
  const selectedId = pendingId ?? savedId
  const dirty = pendingId !== null && pendingId !== savedId

  // Bật/tắt (mute) riêng mỗi trình duyệt — đọc SAU mount (SSR-safe).
  useEffect(() => {
    setEnabled(isSoundEnabled())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Đồng bộ âm CHUNG từ server vào localStorage để playback (play()) dùng đúng.
  useEffect(() => {
    if (data?.sound_id) setNotificationSoundId(data.sound_id)
  }, [data?.sound_id])

  const saveMut = useMutation({
    mutationFn: (id: string) =>
      apiClient.patch("/settings/notification-sound", { sound_id: id }),
    onSuccess: (_res, id) => {
      setNotificationSoundId(id)
      setPendingId(null)
      void qc.invalidateQueries({ queryKey: SOUND_QUERY_KEY })
      toast.success("Đã lưu âm báo — áp dụng cho toàn bộ nhân viên")
    },
    onError: () => toast.error("Không lưu được, vui lòng thử lại"),
  })

  const handleToggle = () => {
    toggleSound()
    setEnabled((prev) => !prev)
  }

  const handlePick = (id: string) => {
    if (!canConfigure) return
    setPendingId(id)
    previewSound(id)
  }

  return (
    <Card className="shadow-[0_4px_16px_rgba(0,0,0,0.06)] rounded-2xl">
      <CardHeader>
        <CardTitle>Âm thanh thông báo</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <button
          type="button"
          onClick={handleToggle}
          aria-pressed={enabled}
          className={cn(
            "flex w-full items-center justify-between rounded-xl border p-4 text-left transition-colors",
            enabled ? "border-[var(--color-app-primary)] bg-[var(--color-app-primary-soft)]/50" : "border-input bg-muted/30",
          )}
        >
          <span className="flex items-center gap-3">
            {enabled ? (
              <Bell className="size-5 text-[var(--color-app-primary-ink)]" />
            ) : (
              <BellOff className="size-5 text-muted-foreground" />
            )}
            <span>
              <span className="block text-sm font-semibold">
                {enabled ? "Đang bật âm báo" : "Đang tắt âm báo"}
              </span>
              <span className="block text-xs text-muted-foreground">
                Bật/tắt tiếng chuông trên máy này (cài đặt riêng của bạn)
              </span>
            </span>
          </span>
          <span
            className={cn(
              "text-xs font-semibold",
              enabled ? "text-[var(--color-app-primary-ink)]" : "text-muted-foreground",
            )}
          >
            {enabled ? "Bật" : "Tắt"}
          </span>
        </button>

        <div className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground">
            {canConfigure
              ? "Chọn tiếng chuông áp dụng cho TOÀN BỘ nhân viên (bấm để nghe thử + chọn)"
              : "Tiếng chuông chung của hệ thống (do quản trị viên thiết lập)"}
          </p>
          {NOTIFICATION_SOUNDS.map((s) => {
            const active = s.id === selectedId
            return (
              <div
                key={s.id}
                className={cn(
                  "flex items-center gap-3 rounded-xl border p-3 transition-colors",
                  active
                    ? "border-[var(--color-app-primary)] bg-[var(--color-app-primary-soft)]/40"
                    : "border-border",
                  canConfigure && !active && "hover:bg-muted/40",
                )}
              >
                <button
                  type="button"
                  onClick={() => handlePick(s.id)}
                  disabled={!canConfigure}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-3 text-left max-sm:min-h-11",
                    !canConfigure && "cursor-default",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded-full border",
                      active
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-muted-foreground/40",
                    )}
                  >
                    {active && <Check className="size-3.5" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">
                      {s.label}
                      {active && (
                        <span className="ml-2 text-xs font-normal text-[var(--color-app-primary-ink)]">
                          (đang áp dụng)
                        </span>
                      )}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {s.description}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => previewSound(s.id)}
                  title="Nghe thử"
                  aria-label={`Nghe thử ${s.label}`}
                  className="inline-flex size-9 max-sm:size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Volume2 className="size-4" />
                </button>
              </div>
            )
          })}
        </div>

        {canConfigure ? (
          <div className="flex items-center gap-3">
            <SettingsSectionActions>
              <Button
                onClick={() => saveMut.mutate(selectedId)}
                disabled={!dirty || saveMut.isPending}
              >
                {saveMut.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-2 h-4 w-4" />
                )}
                {saveMut.isPending ? "Đang lưu..." : "Lưu áp dụng toàn hệ thống"}
              </Button>
            </SettingsSectionActions>
            {dirty && (
              <span className="text-xs text-muted-foreground">
                Bấm Lưu để áp dụng cho mọi nhân viên.
              </span>
            )}
          </div>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="size-3.5" />
            Tiếng chuông chung do quản trị viên thiết lập, áp dụng cho mọi người.
            Bạn có thể nghe thử và bật/tắt âm trên máy mình.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
