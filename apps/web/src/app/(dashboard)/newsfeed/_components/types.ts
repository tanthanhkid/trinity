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

/** Chip mục theo «Ánh xanh»: thông báo = hổ phách, đào tạo = xanh, truyền thông = đỏ nhạt. */
export const CATEGORY_CHIP: Record<
  NewsfeedCategory,
  { tone?: 'new' | 'consult'; style?: Record<string, string> }
> = {
  announcement: { tone: 'consult' },
  training: { tone: 'new' },
  pr: {
    style: {
      '--chip-bg': 'var(--ax-danger-soft)',
      '--chip-ink': '#8a2d28',
      '--chip-dot': 'var(--ax-danger)',
    },
  },
}

/** Chữ màu của nhãn mục trên mobile (đủ tương phản trên nền trắng). */
export const CATEGORY_INK: Record<NewsfeedCategory, string> = {
  announcement: 'text-[var(--ax-stage-consult-ink)]',
  training: 'text-[var(--ax-stage-new-ink)]',
  pr: 'text-[#8a2d28]',
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
