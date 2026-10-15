export const NEWSFEED_CATEGORIES = ['pr', 'training', 'announcement'] as const
export type NewsfeedCategory = (typeof NEWSFEED_CATEGORIES)[number]

export const CATEGORY_LABEL: Record<NewsfeedCategory, string> = {
  pr: 'Truyền thông',
  training: 'Đào tạo',
  announcement: 'Thông báo',
}

export const CATEGORY_BADGE: Record<NewsfeedCategory, string> = {
  pr: 'bg-rose-100 text-rose-700',
  training: 'bg-blue-100 text-blue-700',
  announcement: 'bg-amber-100 text-amber-700',
}

export interface NewsfeedAuthor {
  id: number
  full_name: string
  email: string
  avatar_url: string | null
}

export type NewsfeedMediaType = 'image' | 'video'

export interface NewsfeedPostImage {
  id: number
  image_url: string
  // Bài đăng cũ (trước migration media_type) trả undefined → coi như 'image'.
  media_type?: NewsfeedMediaType
  sort_order: number
}

export interface NewsfeedPost {
  id: number
  category: NewsfeedCategory
  author_id: number
  content: string
  image_url: string | null // legacy — null cho bài mới, có giá trị cho bài cũ
  images: NewsfeedPostImage[]
  edited_at: string | null
  created_at: string
  author: NewsfeedAuthor
  _count: { likes: number; comments: number }
  liked_by_me: boolean
}

export interface NewsfeedComment {
  id: number
  post_id: number
  user_id: number
  content: string
  created_at: string
  user: NewsfeedAuthor
}
