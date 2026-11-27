"use client"

import { useQuery } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import { fromBootstrap } from "@/lib/bootstrap"

export interface ChannelGuardStatus {
  /** false = bản cài một công ty: không có hạn mức/khoá/tạm dừng. */
  enforced: boolean
  plan: string
  limits: { bulkMessagesPerDay: number; recipientsPerCampaign: number; postsPerDay: number; autoCommentRepliesPerHour: number }
  usage: { bulk_messages_today: number; posts_today: number; auto_comment_replies_this_hour: number }
  locked: { locked: boolean; reason: string | null; since: string | null }
  auto_pause: { until: string; reason: string; since: string } | null
  warnings: string[]
  recent_events: Array<{ id: number; kind: string; message: string; at: string }>
}

/** Hạn mức kênh gửi ra ngoài + mức đã dùng + sự kiện. Chỉ quản trị viên (màn Cài đặt). */
export function useChannelGuard() {
  return useQuery<ChannelGuardStatus>({
    queryKey: ["settings", "channel-guard"],
    queryFn: async () => (await apiClient.get<ChannelGuardStatus>("/settings/channel-guard")).data,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  })
}

export interface ChannelAlerts {
  enforced: boolean
  locked: boolean
  paused: boolean
  warnings: string[]
}

/** Cảnh báo nhẹ cho MỌI người dùng đã đăng nhập (banner): chỉ chữ cảnh báo, không lộ hạn mức/sự kiện. */
export function useChannelAlerts() {
  return useQuery<ChannelAlerts>({
    queryKey: ["settings", "channel-guard", "alerts"],
    queryFn: () =>
      fromBootstrap("channel_guard_alerts", async () => (await apiClient.get<ChannelAlerts>("/settings/channel-guard/alerts")).data),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  })
}
