'use client'

import { Suspense, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import { Loader2, MessageSquareText } from 'lucide-react'
import { ShellTabs as Tabs, ShellTabsList as TabsList, ShellTabsTrigger as TabsTrigger } from '@/components/app-shell/tabs'
import { ShellPageHeader } from '@/components/app-shell/page-header'
import { Button } from '@/components/ui/button'
import { ShellEmptyState } from '@/components/app-shell/empty-state'
import apiClient from '@/lib/api-client'
import { PostComposer } from './_components/post-composer'
import { PostCard } from './_components/post-card'
import {
  CATEGORY_LABEL,
  NEWSFEED_CATEGORIES,
  type NewsfeedCategory,
  type NewsfeedPost,
} from './_components/types'

const ALL = 'all' as const
type FilterValue = typeof ALL | NewsfeedCategory

function NewsfeedContent() {
  const [filter, setFilter] = useState<FilterValue>(ALL)
  // Bài cần làm nổi khi mở từ thông báo (action_url = /newsfeed?post=<id>).
  const searchParams = useSearchParams()
  const highlightPostId = Number(searchParams.get('post')) || null

  const postsQuery = useQuery({
    queryKey: ['newsfeed', 'posts', filter],
    queryFn: async (): Promise<{ data: NewsfeedPost[] }> => {
      const params = filter === ALL ? {} : { category: filter }
      const res = await apiClient.get('/newsfeed', { params })
      return res.data
    },
  })

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <ShellPageHeader title="Bảng tin nội bộ" />

      <PostComposer />

      <Tabs value={filter} onValueChange={(v) => setFilter(v as FilterValue)}>
        <TabsList className="w-full">
          <TabsTrigger value={ALL}>
            Tất cả
          </TabsTrigger>
          {NEWSFEED_CATEGORIES.map((c) => (
            <TabsTrigger key={c} value={c}>
              {CATEGORY_LABEL[c]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {postsQuery.isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : postsQuery.isError ? (
        <ShellEmptyState
          icon={MessageSquareText}
          title="Không tải được bảng tin"
          description="Đã xảy ra lỗi khi tải bài đăng."
          action={
            <Button variant="outline" size="sm" onClick={() => postsQuery.refetch()}>
              Thử lại
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {postsQuery.data?.data.map((p) => (
            <PostCard
              key={p.id}
              post={p}
              highlight={highlightPostId === p.id}
            />
          ))}
          {postsQuery.data?.data.length === 0 && (
            <ShellEmptyState
              icon={MessageSquareText}
              title="Chưa có bài đăng"
              description="Chưa có bài đăng nào trong mục này."
            />
          )}
        </div>
      )}
    </div>
  )
}

export default function NewsfeedPage() {
  // useSearchParams() trong Next.js 16 BẮT BUỘC bọc <Suspense>.
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <NewsfeedContent />
    </Suspense>
  )
}
