import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import { pollUnlessChannelOff } from "@/lib/channel-off"
import { inboxPollMs, nextTickMs } from "@/lib/realtime-mode"

export interface FacebookStatus {
  configured: boolean
  app_id_set: boolean
  app_secret_set: boolean
  base_url_set: boolean
  verify_token_set: boolean
  secret_key_configured: boolean
  graph_version: string
  webhook_url: string | null
  oauth_redirect_uri: string | null
  scopes: string[]
  /** Máy chủ đã bật nhận bình luận Page (ứng dụng Facebook đã có quyền đọc/trả lời bình luận). */
  comment_automation?: boolean
}

export type TokenStatus = "active" | "expired" | "invalid" | "unknown"

export interface FacebookPageView {
  id: number
  page_id: string
  name: string
  token_status: TokenStatus
  token_checked_at: string | null
  token_expires_at: string | null
  data_access_expires_at: string | null
  subscribed: boolean
  default_assignee_id: number
  contact_source_id: number
  is_active: boolean
  created_at: string
}

export interface FacebookConversation {
  id: number
  page_id: string
  page_name: string
  psid: string
  customer_name: string | null
  last_inbound_at: string | null
  last_message_at: string
  last_message_preview: string | null
  unread_count: number
  can_reply: boolean
}

export interface FacebookMessage {
  id: string
  direction: "in" | "out"
  text: string | null
  sent_at: string
  sent_by_user_id: number | null
}

export const FB_KEYS = {
  status: ["facebook", "status"] as const,
  pages: ["facebook", "pages"] as const,
  conversations: ["facebook", "conversations"] as const,
  messages: (id: number) => ["facebook", "messages", id] as const,
  comments: ["facebook", "comments"] as const,
  commentRules: ["facebook", "comment-rules"] as const,
  chatLinks: ["facebook", "chat-links"] as const,
  flows: ["facebook", "flows"] as const,
  flowRuns: (id: number) => ["facebook", "flows", id, "runs"] as const,
  broadcasts: ["facebook", "broadcasts"] as const,
  broadcastRecipients: (id: number) => ["facebook", "broadcasts", id, "recipients"] as const,
}

export function useFacebookStatus(enabled: boolean) {
  return useQuery<FacebookStatus>({
    queryKey: FB_KEYS.status,
    enabled,
    staleTime: 60_000,
    queryFn: async () => (await apiClient.get<FacebookStatus>("/facebook/status")).data,
  })
}

export function useFacebookPages(enabled: boolean) {
  return useQuery<FacebookPageView[]>({
    queryKey: FB_KEYS.pages,
    enabled,
    queryFn: async () => (await apiClient.get<{ data: FacebookPageView[] }>("/facebook/pages")).data.data,
  })
}

export function useFacebookPageMutations() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: FB_KEYS.pages })
  return {
    connect: useMutation({ mutationFn: async () => (await apiClient.post<{ url: string }>("/facebook/connect-url")).data.url }),
    update: useMutation({
      mutationFn: async (v: { id: number; default_assignee_id?: number; contact_source_id?: number; is_active?: boolean }) => {
        const { id, ...body } = v
        return (await apiClient.patch<FacebookPageView>(`/facebook/pages/${id}`, body)).data
      },
      onSuccess: refresh,
    }),
    check: useMutation({ mutationFn: async (id: number) => (await apiClient.post<FacebookPageView>(`/facebook/pages/${id}/check`)).data, onSuccess: refresh }),
    remove: useMutation({ mutationFn: async (id: number) => { await apiClient.delete(`/facebook/pages/${id}`) }, onSuccess: refresh }),
  }
}

/** Hộp thư: làm mới 15 giây/lần khi đang mở (không dùng socket — hộp thư đơn giản). */
export function useFacebookConversations(enabled: boolean) {
  return useQuery<FacebookConversation[]>({
    queryKey: FB_KEYS.conversations,
    enabled,
    refetchInterval: pollUnlessChannelOff(inboxPollMs("list", 15_000)),
    queryFn: async () => (await apiClient.get<{ data: FacebookConversation[] }>("/facebook/conversations")).data.data,
  })
}

export function useFacebookMessages(id: number | null) {
  return useQuery<{ conversation: FacebookConversation; messages: FacebookMessage[] }>({
    queryKey: FB_KEYS.messages(id ?? 0),
    enabled: id !== null,
    refetchInterval: inboxPollMs("thread", 10_000),
    queryFn: async () => (await apiClient.get(`/facebook/conversations/${id}/messages`)).data,
  })
}

export function useFacebookReply(id: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (text: string) => (await apiClient.post(`/facebook/conversations/${id}/messages`, { text })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: FB_KEYS.messages(id) })
      qc.invalidateQueries({ queryKey: FB_KEYS.conversations })
    },
  })
}

export const TOKEN_STATUS_LABELS: Record<TokenStatus, string> = {
  active: "Token còn hiệu lực",
  expired: "Token hết hạn",
  invalid: "Token không dùng được — cần kết nối lại",
  unknown: "Chưa kiểm tra",
}

/* ---------- Bình luận tự động ---------- */

export type CommentRuleMode = "test" | "live"

export interface CommentRule {
  id: number
  name: string
  page_id: string | null
  post_id: string | null
  keywords: string[]
  exclude_keywords: string[]
  public_replies: string[]
  private_reply: string | null
  hide_if_phone: boolean
  once_per_user: boolean
  mode: CommentRuleMode
  is_active: boolean
  position: number
}

export type CommentRuleInput = Omit<CommentRule, "id" | "position"> & { position?: number }

export type CommentStatus = "received" | "done" | "test" | "skipped" | "failed" | "replied"

export interface CommentActions {
  public_reply?: { text: string; id?: string; error?: string }
  private_reply?: { text: string; message_id?: string; error?: string }
  hide?: { done?: boolean; error?: string }
  phone_saved?: boolean
  /** Nhân viên trả lời tay từ Trinity. */
  manual?: Array<{ mode: "public" | "private"; text: string; id: string; by: number | null; at: string }>
}

export interface FacebookCommentView {
  id: string
  page_id: string
  page_name: string
  post_id: string
  post_url: string
  from_name: string | null
  message: string | null
  commented_at: string
  contact_id: number | null
  phone: string | null
  rule_name: string | null
  status: CommentStatus
  note: string | null
  actions: CommentActions
  hidden: boolean
  /** Đã có trả lời (luật hoặc nhân viên). */
  answered?: boolean
  /** Còn nhắn riêng được (Facebook: 1 lần, trong 7 ngày). */
  can_private_reply?: boolean
}

export interface CommentDryRun {
  matched_rule: { id: number; name: string; mode: CommentRuleMode } | null
  phone_found: string | null
  actions: CommentActions
}

/** Bình luận mới tới qua webhook — làm mới 20 giây/lần khi đang mở. `unanswered` = chỉ bình luận chưa ai trả lời. */
export function useFacebookComments(enabled: boolean, unanswered = false) {
  return useQuery<FacebookCommentView[]>({
    queryKey: [...FB_KEYS.comments, unanswered ? "unanswered" : "all"],
    enabled,
    refetchInterval: pollUnlessChannelOff(inboxPollMs("list", 20_000)),
    queryFn: async () => (await apiClient.get<{ data: FacebookCommentView[] }>("/facebook/comments", { params: { limit: 30, ...(unanswered ? { unanswered: 1 } : {}) } })).data.data,
  })
}

/** Nhân viên trả lời tay: công khai dưới bình luận hoặc nhắn riêng qua Messenger. */
export function useCommentReply() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { id: string; text: string; mode: "public" | "private" }) => (await apiClient.post(`/facebook/comments/${v.id}/reply`, { text: v.text, mode: v.mode })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: FB_KEYS.comments })
      qc.invalidateQueries({ queryKey: FB_KEYS.conversations })
    },
  })
}

export function useCommentRules(enabled: boolean) {
  return useQuery<CommentRule[]>({
    queryKey: FB_KEYS.commentRules,
    enabled,
    queryFn: async () => (await apiClient.get<{ data: CommentRule[] }>("/facebook/comment-rules")).data.data,
  })
}

export function useCommentRuleMutations() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: FB_KEYS.commentRules })
  return {
    create: useMutation({ mutationFn: async (v: CommentRuleInput) => (await apiClient.post<CommentRule>("/facebook/comment-rules", v)).data, onSuccess: refresh }),
    update: useMutation({
      mutationFn: async ({ id, ...body }: Partial<CommentRuleInput> & { id: number }) => (await apiClient.patch<CommentRule>(`/facebook/comment-rules/${id}`, body)).data,
      onSuccess: refresh,
    }),
    remove: useMutation({ mutationFn: async (id: number) => { await apiClient.delete(`/facebook/comment-rules/${id}`) }, onSuccess: refresh }),
    dryRun: useMutation({
      mutationFn: async (v: { message: string; page_id?: string | null; post_id?: string | null; from_name?: string | null }) =>
        (await apiClient.post<CommentDryRun>("/facebook/comment-rules/dry-run", v)).data,
    }),
  }
}

/** Link/QR mở chat Messenger kèm nguồn khách. `url` = link qua Trinity (đếm lượt mở), null khi máy chủ chưa có địa chỉ công khai. */
export interface ChatLink {
  id: number
  code: string
  name: string
  page_id: string
  page_name: string | null
  source_id: number | null
  source_label: string | null
  is_active: boolean
  clicks: number
  chats: number
  url: string | null
  messenger_url: string
  created_at: string
}

export interface ChatLinkInput {
  name?: string
  page_id?: string
  source_id?: number | null
  is_active?: boolean
}

export function useChatLinks(enabled: boolean) {
  return useQuery<ChatLink[]>({
    queryKey: FB_KEYS.chatLinks,
    enabled,
    queryFn: async () => (await apiClient.get<{ data: ChatLink[] }>("/facebook/chat-links")).data.data,
  })
}

export function useChatLinkMutations() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: FB_KEYS.chatLinks })
  return {
    create: useMutation({ mutationFn: async (v: ChatLinkInput) => (await apiClient.post<ChatLink>("/facebook/chat-links", v)).data, onSuccess: refresh }),
    update: useMutation({
      mutationFn: async ({ id, ...body }: ChatLinkInput & { id: number }) => (await apiClient.patch<ChatLink>(`/facebook/chat-links/${id}`, body)).data,
      onSuccess: refresh,
    }),
    remove: useMutation({ mutationFn: async (id: number) => { await apiClient.delete(`/facebook/chat-links/${id}`) }, onSuccess: refresh }),
  }
}

/* ---- Kịch bản nhắn tin nhiều bước ---- */

export type FlowTrigger = "keyword" | "chat_link" | "first_message"
export type FlowAsk = "phone" | "email" | "note"

export interface FlowButton {
  title: string
  next: string | null
}

export interface FlowStep {
  id: string
  text: string
  wait_minutes?: number
  buttons?: FlowButton[]
  ask?: FlowAsk | null
  /** Không có = bước kế; null = kết thúc. */
  next?: string | null
}

export interface MessageFlow {
  id: number
  name: string
  page_id: string
  page_name: string | null
  trigger: FlowTrigger
  keywords: string[]
  chat_link_id: number | null
  chat_link_name: string | null
  steps: FlowStep[]
  is_active: boolean
  starts: number
  completes: number
  running: number
  updated_at: string
}

export interface FlowInput {
  name?: string
  page_id?: string
  trigger?: FlowTrigger
  keywords?: string[]
  chat_link_id?: number | null
  steps?: FlowStep[]
  is_active?: boolean
}

export type FlowRunStatus = "waiting_button" | "waiting_answer" | "scheduled" | "sending" | "done" | "stopped" | "expired" | "failed"

export interface FlowRun {
  id: number
  flow_id: number
  conversation_id: number
  customer_name: string | null
  contact_id: number | null
  step_id: string | null
  status: FlowRunStatus
  due_at: string | null
  note: string | null
  started_at: string
  updated_at: string
}

export function useMessageFlows(enabled: boolean) {
  return useQuery<MessageFlow[]>({
    queryKey: FB_KEYS.flows,
    enabled,
    queryFn: async () => (await apiClient.get<{ data: MessageFlow[] }>("/facebook/flows")).data.data,
  })
}

export function useFlowRuns(id: number, enabled: boolean) {
  return useQuery<FlowRun[]>({
    queryKey: FB_KEYS.flowRuns(id),
    enabled,
    queryFn: async () => (await apiClient.get<{ data: FlowRun[] }>(`/facebook/flows/${id}/runs`, { params: { limit: 30 } })).data.data,
  })
}

export function useMessageFlowMutations() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: FB_KEYS.flows })
  return {
    create: useMutation({ mutationFn: async (v: FlowInput) => (await apiClient.post<MessageFlow>("/facebook/flows", v)).data, onSuccess: refresh }),
    update: useMutation({
      mutationFn: async ({ id, ...body }: FlowInput & { id: number }) => (await apiClient.patch<MessageFlow>(`/facebook/flows/${id}`, body)).data,
      onSuccess: refresh,
    }),
    remove: useMutation({ mutationFn: async (id: number) => { await apiClient.delete(`/facebook/flows/${id}`) }, onSuccess: refresh }),
  }
}

/* ---- Gửi tin hàng loạt ---- */

export type BroadcastStatus = "draft" | "scheduled" | "sending" | "done" | "cancelled"
export interface BroadcastAudience { source_ids?: number[]; chat_link_ids?: number[] }
export interface Broadcast {
  id: number
  name: string
  page_id: string
  page_name: string | null
  text: string
  audience: BroadcastAudience
  status: BroadcastStatus
  scheduled_at: string | null
  total: number
  sent: number
  failed: number
  skipped: number
  source: string
  started_at: string | null
  finished_at: string | null
  created_at: string
}
export interface BroadcastInput { name?: string; page_id?: string; text?: string; audience?: BroadcastAudience }
export interface BroadcastPreview { eligible: number; outside_window: number; sample: string[] }
export type BroadcastRecipientStatus = "queued" | "sending" | "sent" | "failed" | "skipped"
export interface BroadcastRecipient { id: number; conversation_id: number; customer_name: string | null; contact_id: number | null; status: BroadcastRecipientStatus; note: string | null; sent_at: string | null }

/** Đang gửi / chờ giờ thì tự làm mới để thấy tiến độ. */
export function useBroadcasts(enabled: boolean) {
  return useQuery<Broadcast[]>({
    queryKey: FB_KEYS.broadcasts,
    enabled,
    queryFn: async () => (await apiClient.get<{ data: Broadcast[] }>("/facebook/broadcasts")).data.data,
    refetchInterval: (q) => (q.state.data?.some((b) => b.status === "sending" || b.status === "scheduled") ? 5_000 : false),
  })
}

export function useBroadcastRecipients(id: number, enabled: boolean) {
  return useQuery<BroadcastRecipient[]>({
    queryKey: FB_KEYS.broadcastRecipients(id),
    enabled,
    queryFn: async () => (await apiClient.get<{ data: BroadcastRecipient[] }>(`/facebook/broadcasts/${id}/recipients`)).data.data,
  })
}

export function useBroadcastMutations() {
  const qc = useQueryClient()
  // Lượt gửi mới đổi giờ việc chờ sớm nhất ⇒ hỏi tick lại ngay để hẹn đúng giờ.
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: FB_KEYS.broadcasts }), qc.invalidateQueries({ queryKey: ["facebook", "tick"] })])
  return {
    preview: useMutation({ mutationFn: async (v: { page_id: string; audience: BroadcastAudience }) => (await apiClient.post<BroadcastPreview>("/facebook/broadcasts/preview", v)).data }),
    create: useMutation({ mutationFn: async (v: BroadcastInput) => (await apiClient.post<Broadcast>("/facebook/broadcasts", v)).data, onSuccess: refresh }),
    update: useMutation({
      mutationFn: async ({ id, ...body }: BroadcastInput & { id: number }) => (await apiClient.patch<Broadcast>(`/facebook/broadcasts/${id}`, body)).data,
      onSuccess: refresh,
    }),
    send: useMutation({
      mutationFn: async ({ id, scheduled_at }: { id: number; scheduled_at: string | null }) => (await apiClient.post<Broadcast>(`/facebook/broadcasts/${id}/send`, { scheduled_at })).data,
      onSuccess: refresh,
    }),
    cancel: useMutation({ mutationFn: async (id: number) => (await apiClient.post<Broadcast>(`/facebook/broadcasts/${id}/cancel`)).data, onSuccess: refresh }),
    remove: useMutation({ mutationFn: async (id: number) => { await apiClient.delete(`/facebook/broadcasts/${id}`) }, onSuccess: refresh }),
  }
}

/** Như `useSocialDueTicker`: bản serverless không có job mỗi phút ⇒ web đang mở nhắc máy chủ chạy bước kịch bản / lượt gửi hàng loạt đã tới giờ. */
export function useFacebookDueTicker(enabled: boolean) {
  useQuery({
    queryKey: ["facebook", "tick"],
    queryFn: async () => (await apiClient.post<{ due: boolean; next_at?: string | null }>("/facebook/tick")).data,
    enabled,
    refetchInterval: (q) => nextTickMs(q.state.error ? undefined : q.state.data),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
    staleTime: 20_000,
  })
}
