'use client'

import { Suspense, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import { Loader2, MessageSquareText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { cn } from '@/lib/utils'
import apiClient from '@/lib/api-client'
import { PostComposer } from './_components/post-composer'
import { PostCard } from './_components/post-card'
import {
  CATEGORY_LABEL,
  NEWSFEED_CATEGORIES,
  type NewsfeedCategory,
  type NewsfeedPost,
} from './_components/types'
import { errorMessage } from "@/lib/error-messages"

const ALL = 'all' as const
type FilterValue = typeof ALL | NewsfeedCategory

// Thứ tự mục theo thiết kế «Ánh xanh»: Thông báo · Đào tạo · Truyền thông.
const CATEGORY_ORDER: NewsfeedCategory[] = [...NEWSFEED_CATEGORIES].reverse()
const FILTERS: { value: FilterValue; label: string }[] = [
  { value: ALL, label: 'Tất cả' },
  ...CATEGORY_ORDER.map((c) => ({ value: c as FilterValue, label: CATEGORY_LABEL[c] })),
]

async function fetchPosts(filter: FilterValue): Promise<{ data: NewsfeedPost[]; next_cursor?: number | null }> {
  const params = filter === ALL ? {} : { category: filter }
  const res = await apiClient.get('/newsfeed', { params })
  return res.data
}

function NewsfeedContent() {
  const [filter, setFilter] = useState<FilterValue>(ALL)
  // Bài cần làm nổi khi mở từ thông báo (action_url = /newsfeed?post=<id>).
  const searchParams = useSearchParams()
  const highlightPostId = Number(searchParams.get('post')) || null

  // Luôn tải mục «Tất cả» để đếm số bài từng mục ở thanh bên; mục khác tải riêng như cũ.
  const allQuery = useQuery({
    queryKey: ['newsfeed', 'posts', ALL],
    queryFn: () => fetchPosts(ALL),
  })
  const filteredQuery = useQuery({
    queryKey: ['newsfeed', 'posts', filter],
    queryFn: () => fetchPosts(filter),
    enabled: filter !== ALL,
  })
  const postsQuery = filter === ALL ? allQuery : filteredQuery

  // API chỉ trả MỘT trang (mặc định 10 bài) và không có tổng ⇒ chỉ đếm khi trang «Tất cả» đã là toàn bộ bài
  // (`next_cursor` rỗng); còn trang sau thì ẩn số thay vì hiện số sai.
  const allPage = allQuery.data
  const exact = allPage != null && allPage.next_cursor == null
  const counts: Record<FilterValue, number | null> = {
    [ALL]: exact ? allPage.data.length : null,
    announcement: null,
    training: null,
    pr: null,
  }
  for (const c of NEWSFEED_CATEGORIES) {
    counts[c] = exact ? allPage.data.filter((p) => p.category === c).length : null
  }

  const posts = postsQuery.data?.data

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col lg:flex-row lg:items-start lg:justify-center lg:gap-7">
      {/* DESKTOP: mục dọc bên trái */}
      <aside
        aria-label="Mục bảng tin"
        className="hidden shrink-0 flex-col gap-1 lg:sticky lg:top-6 lg:flex lg:w-[220px]"
      >
        <h1 className="mb-3 text-2xl font-semibold tracking-[-0.02em] text-ax-ink">Bảng tin</h1>
        {FILTERS.map((f) => {
          const on = filter === f.value
          return (
            <button
              key={f.value}
              type="button"
              aria-pressed={on}
              onClick={() => setFilter(f.value)}
              className={cn(
                'flex h-11 cursor-pointer items-center justify-between rounded-ax-field px-3.5 text-left text-[15px] transition-colors',
                on
                  ? 'bg-[image:linear-gradient(180deg,#f5f9fd,#e8f0f8)] font-semibold text-[var(--ax-stage-new-ink)]'
                  : 'font-medium text-ax-ink-2 hover:bg-ax-hover',
              )}
            >
              <span>{f.label}</span>
              <span className="text-[13px] text-ax-ink-2 tabular-nums">{counts[f.value] ?? ''}</span>
            </button>
          )
        })}
        <p className="mx-3.5 mt-3.5 text-[13px] leading-normal text-ax-ink-2">
          Bài đăng ở đây cả công ty đều đọc được. Chỉ tác giả hoặc quản lý mới sửa được bài.
        </p>
      </aside>

      {/* MOBILE: tiêu đề + mục trên khối xanh dính đầu trang */}
      <div className="sticky top-0 z-10 -mx-4 -mt-4 border-b border-[var(--ax-hero-border)] ax-grad-hero px-4 pt-[18px] sm:-mx-5 sm:-mt-5 sm:px-5 pb-0 shadow-[0_14px_26px_-16px_rgba(26,60,93,.75)] lg:hidden">
        <h1 className="mb-3 text-[28px] leading-[1.1] font-bold tracking-[-0.02em] text-white">Bảng tin</h1>
        <div role="tablist" aria-label="Mục" className="flex gap-2 overflow-x-auto pb-3">
          {FILTERS.map((f) => {
            const on = filter === f.value
            return (
              <button
                key={f.value}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setFilter(f.value)}
                className={cn(
                  'h-11 shrink-0 cursor-pointer rounded-full px-4 text-[15px] font-semibold shadow-[inset_0_0_0_1px_rgba(255,255,255,.22)]',
                  on ? 'bg-white text-[var(--ax-stage-new-ink)]' : 'bg-[rgba(13,32,54,.32)] text-white',
                )}
              >
                {f.label}
              </button>
            )
          })}
        </div>
      </div>

      <main className="flex min-w-0 flex-1 flex-col gap-2 pb-24 max-lg:mt-2 lg:max-w-[700px] lg:gap-3.5 lg:pb-0">
        <PostComposer />

        {postsQuery.isLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="size-6 animate-spin text-ax-ink-3" />
          </div>
        ) : postsQuery.isError ? (
          <EmptyState
            variant="ax"
            icon={MessageSquareText}
            title="Không tải được bảng tin"
            message={errorMessage(postsQuery.error, "Không tải được bài đăng")}
            action={
              <Button variant="ax-secondary" size="ax" onClick={() => postsQuery.refetch()}>
                Thử lại
              </Button>
            }
          />
        ) : (
          <>
            {posts?.map((p) => (
              <PostCard key={p.id} post={p} highlight={highlightPostId === p.id} />
            ))}
            {posts?.length === 0 && (
              <EmptyState
                variant="ax"
                icon={MessageSquareText}
                message="Mục này chưa có bài nào. Bài đầu tiên của bạn sẽ hiện ở đây."
                className="my-6 py-10"
              />
            )}
          </>
        )}
      </main>
    </div>
  )
}

export default function NewsfeedPage() {
  // useSearchParams() trong Next.js 16 BẮT BUỘC bọc <Suspense>.
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-ax-ink-3" />
        </div>
      }
    >
      <NewsfeedContent />
    </Suspense>
  )
}
