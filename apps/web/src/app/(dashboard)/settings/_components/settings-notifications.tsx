"use client"

import { SettingsNotificationSound } from "./settings-notification-sound"

/**
 * Cài đặt → Thông báo: hiện chỉ gồm cài đặt âm báo.
 */
export function SettingsNotifications() {
  return (
    <div className="space-y-4">
      <SettingsNotificationSound />
    </div>
  )
}
