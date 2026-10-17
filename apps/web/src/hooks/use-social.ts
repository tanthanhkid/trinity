"use client"

import axios from "axios"
import { keepPreviousData, useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import apiClient from "@/lib/api-client"
import { nextTickMs } from "@/lib/realtime-mode"

export type SocialNetwork = "facebook" | "instagram" | "youtube" | "tiktok" | "google_business"

/** Giới hạn ký tự theo mạng — khớp `CAPTION_LIMITS` phía BE. */
export const CAPTION_LIMITS: Record<SocialNetwork, number> = { facebook: 63_206, instagram: 2_200, youtube: 5_000, tiktok: 2_200, google_business: 1_500 }

/** Quyền xem video YouTube — mặc định Riêng tư (khớp `youtubePrivacy` phía BE). */
export const YOUTUBE_PRIVACY_LABELS = { private: "Riêng tư", unlisted: "Không công khai", public: "Công khai" } as const
export type YoutubePrivacy = keyof typeof YOUTUBE_PRIVACY_LABELS

/** Danh mục video YouTube — khớp `YOUTUBE_CATEGORIES` phía BE. */
export const YOUTUBE_CATEGORY_LABELS = {
  "22": "Mọi người & Blog",
  "27": "Giáo dục",
  "28": "Khoa học & Công nghệ",
  "26": "Hướng dẫn & Phong cách",
  "24": "Giải trí",
  "10": "Âm nhạc",
  "20": "Trò chơi",
  "25": "Tin tức & Chính trị",
  "17": "Thể thao",
  "19": "Du lịch & Sự kiện",
  "1": "Phim & Hoạt hình",
  "2": "Ô tô & Xe cộ",
  "15": "Thú cưng & Động vật",
  "23": "Hài kịch",
  "29": "Tổ chức phi lợi nhuận",
} as const
export type YoutubeCategory = keyof typeof YOUTUBE_CATEGORY_LABELS

export function useYoutubePlaylists(accountId: number, enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, "youtube-playlists", accountId],
    queryFn: async () => (await apiClient.get<{ data: Array<{ id: string; title: string }> }>(`/social/accounts/${accountId}/youtube-playlists`)).data.data,
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  })
}

/** Quyền xem video TikTok. Không có mặc định: TikTok yêu cầu người đăng tự chọn, và chỉ trong các mức tài khoản cho phép. */
export const TIKTOK_PRIVACY_LABELS = {
  SELF_ONLY: "Chỉ mình tôi",
  MUTUAL_FOLLOW_FRIENDS: "Bạn bè",
  FOLLOWER_OF_CREATOR: "Người theo dõi",
  PUBLIC_TO_EVERYONE: "Mọi người",
} as const
export type TiktokPrivacy = keyof typeof TIKTOK_PRIVACY_LABELS

export interface SocialNetworkInfo {
  network: SocialNetwork
  label: string
  supported: boolean
  configured: boolean
  env: string[]
  scopes: string[]
  redirect_uri: string | null
}

export interface SocialAccount {
  id: number
  network: SocialNetwork
  name: string
  avatar_url: string | null
  status: "active" | "reauth" | "disabled"
  last_error: string | null
  /** Người dùng đã gỡ kênh (hiện mờ, có nút "Bật lại"). */
  removed?: boolean
  /** Chỉ Fanpage: phần nhận tin của cùng Page — null = chưa nối. */
  inbox?: "on" | "off" | null
}

export interface SocialMediaItem {
  key: string
  type: "image" | "video"
  content_type: string
  size: number
}

export interface SocialTarget {
  id: number
  account_id: number
  account_name: string | null
  network: SocialNetwork
  caption: string | null
  status: "queued" | "publishing" | "published" | "failed" | "cancelled"
  attempts: number
  url: string | null
  last_error: string | null
  published_at: string | null
  /** Tuỳ chọn riêng của kênh (tiêu đề/quyền xem YouTube, TikTok…) — dùng khi sửa bài hẹn giờ. */
  options?: Record<string, unknown> | null
  /** Số lấy từ mạng; null = chưa lấy được lần nào. Từng số null = mạng không cung cấp. */
  metrics?: SocialMetrics | null
  metrics_at?: string | null
}

export interface SocialMetrics {
  views: number | null
  reactions: number | null
  comments: number | null
  shares: number | null
  /** Bài đã bị xoá trên kênh (số là lần lấy cuối, nếu có). */
  removed?: boolean
}

export interface SocialStats {
  from: string
  to: string
  totals: { posts: number; published: number; views: number | null; reactions: number; comments: number; shares: number }
  by_account: Array<{ account_id: number; account_name: string | null; network: SocialNetwork; published: number; with_metrics: number; views: number | null; reactions: number; comments: number; shares: number }>
  top: Array<{
    post_id: number
    target_id: number
    account_name: string | null
    network: SocialNetwork
    content: string
    url: string | null
    published_at: string | null
    metrics: SocialMetrics | null
    engagement: number
    removed?: boolean
  }>
  without_metrics: number
  /** Lượt đăng mà bài đã bị xoá trên kênh. */
  removed?: number
  updated_at: string | null
}

export interface SocialPost {
  id: number
  content: string
  media: SocialMediaItem[]
  scheduled_at: string | null
  status: "scheduled" | "publishing" | "published" | "partial" | "failed" | "cancelled"
  source: string
  created_at: string
  targets: SocialTarget[]
}

export interface CreateSocialPostBody {
  content: string
  media_keys: string[]
  targets: Array<{ account_id: number; caption?: string | null; options?: Record<string, unknown> }>
  scheduled_at?: string | null
  /** Đặt vào khung trống gần nhất của hàng đợi (thay cho scheduled_at). */
  use_queue?: boolean
  /** Gắn UTM vào liên kết khi đăng (chung cho mọi kênh). */
  utm?: { campaign: string; content?: string } | null
}

/** Bài nháp (GET social/drafts): được thiếu kênh / nội dung / giờ. `ui` = trạng thái ô soạn của web để mở lại đúng như cũ. */
export interface SocialDraft {
  id: number
  title: string | null
  content: string
  media: Array<SocialMediaItem & { name?: string }>
  targets: Array<{ account_id: number; caption?: string | null; options?: Record<string, unknown> }>
  scheduled_at: string | null
  ui: Record<string, unknown> | null
  source: string
  created_at: string
  updated_at: string
}

export interface SocialDraftBody {
  title?: string | null
  content?: string
  media?: Array<{ key: string; name?: string }>
  targets?: Array<{ account_id: number; caption?: string | null; options?: Record<string, unknown> }>
  scheduled_at?: string | null
  /** Khi đăng: vào khung trống gần nhất của hàng đợi. */
  use_queue?: boolean
  /** Gắn UTM khi đăng; máy chủ ghi vào tuỳ chọn từng kênh của nháp. null = bỏ. */
  utm?: { campaign: string; content?: string } | null
  ui?: Record<string, unknown> | null
}

const KEY = ["social"] as const

/** Khung giờ hàng đợi: `weekday` 0 = Chủ nhật … 6 = Thứ bảy, `minute` = số phút từ 00:00 — đều theo giờ Việt Nam. */
export interface QueueSlot {
  weekday: number
  minute: number
}

export function useQueueSlots() {
  return useQuery({
    queryKey: [...KEY, "queue", "slots"],
    queryFn: async () => (await apiClient.get<{ data: QueueSlot[] }>("/social/queue/slots")).data.data,
  })
}

/** Xem trước một kênh — khớp `TargetPreview` phía BE (`POST /social/posts/preview`). */
export interface SocialTargetPreview {
  account_id: number
  account_name: string
  network: SocialNetwork | null
  text: string
  title: string | null
  description: string | null
  first_comment: string | null
  length: number
  limit: number | null
  /** Vị trí mạng gập "Xem thêm" (xấp xỉ; YouTube tính trên mô tả); null = hiện đủ. */
  truncated_at: number | null
  media: Array<{ key: string; type: "image" | "video" }>
  warnings: string[]
}
export interface SocialPostPreview {
  scheduled_at: string | null
  from_queue: boolean
  warnings: string[]
  targets: SocialTargetPreview[]
}

/** Thân giống `POST /social/posts`. */
export interface SocialPreviewBody {
  content: string
  media_keys: string[]
  targets: Array<{ account_id: number; caption: string | null; options?: Record<string, unknown> }>
  scheduled_at?: string | null
  use_queue?: boolean
  utm?: { campaign: string; content?: string } | null
}

/** Xem trước theo kênh; giữ kết quả cũ trong lúc tải bản mới để màn không nhấp nháy. Chỉ gọi khi `enabled`. */
export function useSocialPreview(body: SocialPreviewBody, enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, "preview", body],
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => (await apiClient.post<{ data: SocialPostPreview }>("/social/posts/preview", body)).data.data,
  })
}

/** `count` khung trống gần nhất (ISO 8601). */
export function useQueueNext(count = 1, enabled = true) {
  return useQuery({
    queryKey: [...KEY, "queue", "next", count],
    enabled,
    queryFn: async () => (await apiClient.get<{ data: string[] }>("/social/queue/next", { params: { count } })).data.data,
  })
}

/** Bài lặp lại — khớp `RecurrenceView` phía BE. */
export interface SocialRecurrence {
  id: number
  title: string
  template: { content: string; media_keys: string[]; targets: Array<{ account_id: number; caption?: string | null; options?: Record<string, unknown> }>; utm?: { campaign: string; content?: string } | null }
  rule: { freq: "daily" | "weekly" | "monthly"; interval: number; weekdays?: number[]; month_day?: number; time: string }
  starts_on: string
  ends_on: string | null
  max_count: number | null
  count: number
  next_run_at: string | null
  active: boolean
  last_error: string | null
  /** 3 lần đăng tới (ISO, máy chủ tính). */
  next_times: string[]
  posts: Array<{ id: number; status: SocialPost["status"]; scheduled_at: string | null }>
}

export interface CreateRecurrenceBody {
  title: string
  template: { content: string; media_keys: string[]; targets: Array<{ account_id: number; caption: string | null; options?: Record<string, unknown> }>; utm?: { campaign: string; content?: string } | null }
  rule: SocialRecurrence["rule"]
  starts_on: string
  ends_on: string | null
  max_count: number | null
}

export function useSocialRecurrences() {
  return useQuery({
    queryKey: [...KEY, "recurrences"],
    queryFn: async () => (await apiClient.get<{ data: SocialRecurrence[] }>("/social/recurrences")).data.data,
  })
}

export function useRecurrenceMutations() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: KEY })
  return {
    pause: useMutation({ mutationFn: async (id: number) => (await apiClient.post<{ data: SocialRecurrence }>(`/social/recurrences/${id}/pause`)).data.data, onSuccess: refresh }),
    resume: useMutation({ mutationFn: async (id: number) => (await apiClient.post<{ data: SocialRecurrence }>(`/social/recurrences/${id}/resume`)).data.data, onSuccess: refresh }),
    remove: useMutation({ mutationFn: (id: number) => apiClient.delete(`/social/recurrences/${id}`), onSuccess: refresh }),
  }
}

export function useSocialDrafts() {
  return useQuery({
    queryKey: [...KEY, "drafts"],
    queryFn: async () => (await apiClient.get<{ data: SocialDraft[] }>("/social/drafts")).data.data,
  })
}

/** Bộ hashtag / chữ ký dùng lại khi soạn bài. */
export interface SocialSnippet {
  id: number
  kind: "hashtags" | "signature"
  name: string
  content: string
  is_default: boolean
  position: number
}

export function useSocialSnippets() {
  return useQuery({
    queryKey: [...KEY, "snippets"],
    queryFn: async () => (await apiClient.get<{ data: SocialSnippet[] }>("/social/snippets")).data.data,
  })
}

export function useSnippetMutations() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: [...KEY, "snippets"] })
  return {
    save: useMutation({
      mutationFn: async ({ id, body }: { id?: number; body: { kind?: SocialSnippet["kind"]; name?: string; content?: string; is_default?: boolean } }) =>
        (id ? await apiClient.patch<{ data: SocialSnippet }>(`/social/snippets/${id}`, body) : await apiClient.post<{ data: SocialSnippet }>("/social/snippets", body)).data.data,
      onSuccess: refresh,
    }),
    remove: useMutation({ mutationFn: (id: number) => apiClient.delete(`/social/snippets/${id}`), onSuccess: refresh }),
  }
}

export function useSocialNetworks() {
  return useQuery({
    queryKey: [...KEY, "networks"],
    queryFn: async () => (await apiClient.get<{ data: SocialNetworkInfo[] }>("/social/networks")).data.data,
  })
}

/** Mặc định chỉ kênh đang dùng (chọn kênh đăng bài); màn Kênh truyền `includeRemoved` để thấy cả kênh đã gỡ. */
export function useSocialAccounts(enabled = true, includeRemoved = false) {
  return useQuery({
    queryKey: [...KEY, "accounts"],
    queryFn: async () => (await apiClient.get<{ data: SocialAccount[] }>("/social/accounts")).data.data,
    select: (rows) => (includeRemoved ? rows : rows.filter((a) => !a.removed)),
    enabled,
  })
}

/** creator_info của kênh TikTok (TikTok yêu cầu hiện trên màn soạn, lấy mới mỗi lần mở). */
export interface TiktokCreatorInfo {
  nickname: string | null
  username: string | null
  avatar_url: string | null
  privacy_level_options: string[]
  comment_disabled: boolean
  duet_disabled: boolean
  stitch_disabled: boolean
  max_video_post_duration_sec: number | null
}

const tiktokCreatorQuery = (accountId: number) => ({
  queryKey: [...KEY, "tiktok-creator", accountId],
  queryFn: async () => (await apiClient.get<{ data: TiktokCreatorInfo }>(`/social/accounts/${accountId}/tiktok-creator`)).data.data,
  staleTime: 30_000,
  retry: false,
})

export function useTiktokCreatorInfo(accountId: number, enabled: boolean) {
  return useQuery({ ...tiktokCreatorQuery(accountId), enabled })
}

/** creator_info của nhiều kênh TikTok cùng lúc (chung cache với `useTiktokCreatorInfo`). */
export function useTiktokCreatorInfos(accountIds: number[]): Record<number, TiktokCreatorInfo | undefined> {
  const qs = useQueries({ queries: accountIds.map(tiktokCreatorQuery) })
  return Object.fromEntries(accountIds.map((id, i) => [id, qs[i]?.data]))
}

export function useSocialPosts() {
  return useQuery({
    queryKey: [...KEY, "posts"],
    queryFn: async () => (await apiClient.get<{ data: SocialPost[]; next_cursor: number | null }>("/social/posts", { params: { limit: 50 } })).data,
    // Bài đang đăng nền: tự làm mới tới khi xong.
    refetchInterval: (q) => (q.state.data?.data.some((p) => p.status === "publishing") ? 5_000 : false),
  })
}

/** Bài trong một khoảng (lịch): bài hẹn giờ tính theo giờ hẹn, bài đăng ngay theo giờ tạo. Tối đa 100 bài. */
export const CALENDAR_MAX_POSTS = 100

export function useSocialPostsRange(from: string, to: string) {
  return useQuery({
    queryKey: [...KEY, "posts", "range", from, to],
    queryFn: async () =>
      (await apiClient.get<{ data: SocialPost[]; next_cursor: number | null }>("/social/posts", { params: { from, to, limit: CALENDAR_MAX_POSTS } })).data,
    refetchInterval: (q) => (q.state.data?.data.some((p) => p.status === "publishing") ? 5_000 : false),
  })
}

/** Thống kê bài đã đăng trong `days` ngày gần nhất. */
export function useSocialStats(days: number) {
  return useQuery({
    queryKey: [...KEY, "stats", days],
    queryFn: async () => {
      const to = new Date()
      const from = new Date(to.getTime() - days * 86_400_000)
      return (await apiClient.get<SocialStats>("/social/stats", { params: { from: from.toISOString(), to: to.toISOString(), top: 10 } })).data
    },
  })
}

export type SocialImportMode = "drafts" | "schedule"

export interface SocialImportRowPlan {
  /** Dòng trong tệp (dòng tiêu đề là 1). */
  row: number
  ok: boolean
  errors: string[]
  warnings: string[]
  preview: {
    channels: Array<{ account_id: number; name: string; network: string }>
    scheduled_at: string | null
    use_queue: boolean
    content_excerpt: string
  }
}

export interface SocialImportPlan {
  mode: SocialImportMode
  plan_hash: string
  total: number
  ok_count: number
  error_count: number
  rows: SocialImportRowPlan[]
  unknown_columns?: string[]
}

export interface SocialImportResult {
  mode: SocialImportMode
  created: Array<{ row: number; id: number }>
  skipped: Array<{ row: number; errors: string[] }>
}

/** Nhập nhiều bài từ CSV: `plan` chỉ kiểm (không ghi), `run` tạo các dòng hợp lệ và gửi plan_hash đã xem (khác ⇒ 409). */
export function useSocialImport() {
  const qc = useQueryClient()
  return {
    plan: useMutation({
      mutationFn: async (body: { csv: string; mode: SocialImportMode }) => (await apiClient.post<{ data: SocialImportPlan }>("/social/posts/import/plan", body)).data.data,
    }),
    run: useMutation({
      mutationFn: async (body: { csv: string; mode: SocialImportMode; plan_hash: string }) => (await apiClient.post<SocialImportResult>("/social/posts/import", body)).data,
      onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
    }),
  }
}

export function useSocialMutations() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: KEY })
  return {
    connect: useMutation({
      mutationFn: async (network: SocialNetwork) => (await apiClient.post<{ url: string }>("/social/accounts/connect-url", { network })).data.url,
    }),
    disconnect: useMutation({ mutationFn: (id: number) => apiClient.delete(`/social/accounts/${id}`), onSuccess: refresh }),
    enable: useMutation({ mutationFn: (id: number) => apiClient.post(`/social/accounts/${id}/enable`), onSuccess: refresh }),
    create: useMutation({ mutationFn: async (body: CreateSocialPostBody) => (await apiClient.post<SocialPost>("/social/posts", body)).data, onSuccess: refresh }),
    /** Tạo bài lặp lại (thay cho tạo bài): máy chủ giữ đúng một bài hẹn sắp tới. */
    createRecurrence: useMutation({ mutationFn: async (body: CreateRecurrenceBody) => (await apiClient.post<{ data: SocialRecurrence }>("/social/recurrences", body)).data.data, onSuccess: refresh }),
    update: useMutation({ mutationFn: async ({ id, body }: { id: number; body: CreateSocialPostBody }) => (await apiClient.patch<SocialPost>(`/social/posts/${id}`, body)).data, onSuccess: refresh }),
    /** Lưu nháp: có `id` thì sửa nháp đó, không thì tạo mới. */
    saveDraft: useMutation({
      mutationFn: async ({ id, body }: { id?: number; body: SocialDraftBody }) =>
        (id ? await apiClient.patch<{ data: SocialDraft }>(`/social/drafts/${id}`, body) : await apiClient.post<{ data: SocialDraft }>("/social/drafts", body)).data.data,
      onSuccess: refresh,
    }),
    /** Thay toàn bộ khung giờ hàng đợi. */
    setQueueSlots: useMutation({
      mutationFn: async (slots: QueueSlot[]) => (await apiClient.put<{ data: QueueSlot[] }>("/social/queue/slots", { slots })).data.data,
      onSuccess: refresh,
    }),
    deleteDraft: useMutation({ mutationFn: (id: number) => apiClient.delete(`/social/drafts/${id}`), onSuccess: refresh }),
    /** Đăng nháp thành bài thật (kiểm đầy đủ như tạo bài); `scheduled_at` ghi đè giờ của nháp. */
    publishDraft: useMutation({
      mutationFn: async ({ id, scheduled_at, use_queue, expected_updated_at }: { id: number; scheduled_at?: string | null; use_queue?: boolean; expected_updated_at?: string }) =>
        (await apiClient.post<SocialPost>(`/social/drafts/${id}/publish`, { ...(scheduled_at === undefined ? {} : { scheduled_at }), ...(use_queue ? { use_queue: true } : {}), ...(expected_updated_at ? { expected_updated_at } : {}) })).data,
      onSuccess: refresh,
    }),
    reschedule: useMutation({ mutationFn: async ({ id, at }: { id: number; at: string }) => (await apiClient.post<SocialPost>(`/social/posts/${id}/reschedule`, { scheduled_at: at })).data, onSuccess: refresh }),
    cancel: useMutation({ mutationFn: (id: number) => apiClient.post(`/social/posts/${id}/cancel`), onSuccess: refresh }),
    retry: useMutation({ mutationFn: (targetId: number) => apiClient.post(`/social/targets/${targetId}/retry`), onSuccess: refresh }),
    refreshMetrics: useMutation({ mutationFn: (postId: number) => apiClient.post(`/social/posts/${postId}/metrics`), onSuccess: refresh }),
    removeRemote: useMutation({
      mutationFn: async (targetId: number) => (await apiClient.delete<SocialPost>(`/social/targets/${targetId}/remote`)).data,
      // Đặt ngay bài server trả về vào danh sách, để nút "Gỡ khỏi mạng" biến mất mà không phải tải lại trang.
      onSuccess: (post) => {
        qc.setQueryData<{ data: SocialPost[]; next_cursor: number | null }>([...KEY, "posts"], (old) =>
          old && post?.id ? { ...old, data: old.data.map((p) => (p.id === post.id ? post : p)) } : old,
        )
        return refresh()
      },
    }),
  }
}

/** Một tệp trong thư viện ảnh/video dùng chung. */
export interface SocialLibraryItem extends SocialMediaItem {
  id: number
  name: string
  source: string
  uploaded_by: number
  created_at: string
}

export function useSocialLibrary(type?: "image" | "video", q?: string) {
  return useInfiniteQuery({
    queryKey: [...KEY, "library", type ?? "all", q ?? ""],
    queryFn: async ({ pageParam }) =>
      (await apiClient.get<{ data: SocialLibraryItem[]; next_cursor: number | null }>("/social/media", { params: { type, q: q || undefined, limit: 24, cursor: pageParam } })).data,
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  })
}

export function useHideSocialMedia() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => apiClient.post(`/social/media/${id}/hide`),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, "library"] }),
  })
}

/** Ảnh xem trước của một tệp trong thư viện (tải qua BE kèm đăng nhập → object URL, giữ trong cache suốt phiên để mở lại không tải lại). */
export function useSocialMediaPreview(id: number, enabled: boolean) {
  const q = useQuery({
    queryKey: [...KEY, "media-file", id],
    queryFn: async () => URL.createObjectURL((await apiClient.get<Blob>(`/social/media/${id}/file`, { responseType: "blob" })).data),
    enabled,
    staleTime: Infinity,
    gcTime: Infinity,
  })
  return { url: q.data ?? null, isError: q.isError }
}

interface UploadGrant extends SocialMediaItem {
  upload_url: string
  headers: Record<string, string>
}

/**
 * Tải một tệp: Vercel → xin token rồi PUT thẳng lên Blob (body hàm ≤ 4,5 MB); môi trường khác (BE trả 400) → multipart qua BE.
 */
export async function uploadSocialFile(file: File, onProgress: (pct: number) => void): Promise<SocialMediaItem> {
  let grant: UploadGrant | null = null
  try {
    grant = (await apiClient.post<UploadGrant>("/social/media/upload-token", { file_name: file.name, size: file.size })).data
  } catch (err) {
    if (!(axios.isAxiosError(err) && err.response?.status === 400 && /upload trực tiếp/.test(String(err.response?.data?.message ?? "")))) throw err
  }
  if (grant) {
    // axios trần (KHÔNG apiClient) — không gửi JWT của CRM sang Blob.
    await axios.put(grant.upload_url, file, {
      headers: grant.headers,
      onUploadProgress: (e) => e.total && onProgress(Math.round((e.loaded / e.total) * 100)),
    })
    const item: SocialMediaItem = { key: grant.key, type: grant.type, content_type: grant.content_type, size: file.size }
    // Đưa vào thư viện chung để dùng lại; lỗi ở bước này không chặn việc đăng bài.
    await apiClient.post("/social/media/register", { key: grant.key, name: file.name }).catch(() => undefined)
    return item
  }
  const form = new FormData()
  form.append("file", file)
  const res = await apiClient.post<SocialMediaItem>("/social/media", form, {
    onUploadProgress: (e) => e.total && onProgress(Math.round((e.loaded / e.total) * 100)),
  })
  return res.data
}

/**
 * Bản serverless không có job nền chạy mỗi phút (Vercel Cron gói thường chỉ chạy mỗi ngày) → khi có người mở Trinity,
 * web nhắc máy chủ đăng các bài đã tới giờ hẹn / tới lượt thử lại. Bản VPS có timer riêng nên không gọi.
 */
export function useSocialDueTicker(enabled: boolean) {
  useQuery({
    queryKey: ["social", "tick"],
    queryFn: async () => (await apiClient.post<{ due: boolean; next_at?: string | null }>("/social/tick")).data,
    enabled,
    // Hẹn lượt kế theo giờ bài chờ sớm nhất máy chủ báo (không gọi mỗi phút — CPU Vercel).
    refetchInterval: (q) => nextTickMs(q.state.error ? undefined : q.state.data),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
    staleTime: 20_000,
  })
}

/** Một đánh giá Google (đọc thẳng từ Google Business Profile, không lưu bản sao). */
export interface GoogleReview {
  id: string
  reviewer: string
  reviewer_photo: string | null
  stars: number | null
  comment: string | null
  created_at: string | null
  updated_at: string | null
  reply: { comment: string; updated_at: string | null } | null
}

export interface GoogleReviewsPage {
  reviews: GoogleReview[]
  average: number | null
  total: number
  next_page_token: string | null
}

export function useGoogleReviews(accountId: number | null) {
  return useInfiniteQuery({
    queryKey: [...KEY, "google-reviews", accountId],
    queryFn: async ({ pageParam }) =>
      (await apiClient.get<{ data: GoogleReviewsPage }>(`/social/accounts/${accountId}/google-reviews`, { params: { page_token: pageParam } })).data.data,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_page_token ?? undefined,
    enabled: accountId !== null,
    retry: false,
  })
}

export function useReplyGoogleReview(accountId: number | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ reviewId, comment }: { reviewId: string; comment: string }) =>
      (await apiClient.post<{ data: { comment: string; updated_at: string | null } }>(`/social/accounts/${accountId}/google-reviews/${encodeURIComponent(reviewId)}/reply`, { comment })).data.data,
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, "google-reviews", accountId] }),
  })
}

/** Bài còn sửa / đổi giờ được: đang hẹn giờ, còn hơn 1 phút mới tới giờ, mọi kênh chưa huỷ đều còn chờ (khớp kiểm tra phía BE). */
export function isPostEditable(p: Pick<SocialPost, "status" | "scheduled_at" | "targets">, now = Date.now()): boolean {
  if (p.status !== "scheduled" || !p.scheduled_at) return false
  if (Date.parse(p.scheduled_at) <= now + 60_000) return false
  const live = p.targets.filter((t) => t.status !== "cancelled")
  return live.length > 0 && live.every((t) => t.status === "queued")
}

/** Kéo bài sang ngày `day` (YYYY-MM-DD, giờ VN): giữ nguyên giờ:phút theo giờ Việt Nam. */
export function movedSchedule(scheduledAt: string, day: string): string {
  const hm = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(scheduledAt))
  return new Date(`${day}T${hm}:00+07:00`).toISOString()
}

/** `options` đã lưu của một kênh → gửi lại khi sửa: ảnh thumbnail YouTube gửi bằng `thumbnail_key` (BE kiểm lại). */
export function optionsForResubmit(options: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const { thumbnail, ...rest } = options ?? {}
  const key = thumbnail && typeof thumbnail === "object" ? (thumbnail as { key?: unknown }).key : undefined
  return typeof key === "string" ? { ...rest, thumbnail_key: key } : rest
}
