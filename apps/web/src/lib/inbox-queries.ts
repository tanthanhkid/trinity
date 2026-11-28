import apiClient from './api-client'

/**
 * Truy vấn của màn Tương tác (Hộp thư). Tách khỏi component để `route-prefetch.ts` nạp trước dữ liệu khi rê chuột vào mục
 * menu mà không kéo cả màn vào gói dùng chung. Khoá và tham số PHẢI giống hệt nhau giữa chỗ nạp trước và màn.
 */
export interface InteractionFilter { type: "" | "comment" | "message"; channel: "" | "facebook" | "zalo"; unanswered: boolean; rule: "" | "1" | "0"; from: string; to: string; q: string }
export const EMPTY_FILTER: InteractionFilter = { type: "", channel: "", unanswered: false, rule: "", from: "", to: "", q: "" }

export function filterParams(f: InteractionFilter): Record<string, string> {
  const p: Record<string, string> = {}
  if (f.type) p.type = f.type
  if (f.channel) p.channel = f.channel
  if (f.unanswered) p.status = "unanswered"
  if (f.rule) p.has_rule = f.rule
  if (f.from) p.from = `${f.from}T00:00:00+07:00`
  if (f.to) p.to = `${f.to}T23:59:59+07:00`
  if (f.q.trim()) p.q = f.q.trim()
  return p
}


export interface InteractionStats { messages_today: number; comments_today: number; auto_handled_today: number; unanswered_7d: number }

export const INTERACTION_STATS_KEY = ['interactions', 'stats'] as const
export const interactionListKey = (f: InteractionFilter) => ['interactions', 'list', f] as const

export async function fetchInteractionStats(): Promise<InteractionStats> {
  return (await apiClient.get<InteractionStats>('/interactions/stats')).data
}

export async function fetchInteractions<T = { data: unknown[]; next_before: string | null }>(f: InteractionFilter): Promise<T> {
  return (await apiClient.get('/interactions', { params: { ...filterParams(f), limit: 60 } })).data
}
