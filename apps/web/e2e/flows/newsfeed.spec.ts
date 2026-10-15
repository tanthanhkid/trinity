import { test, expect } from '@playwright/test'
import { storageStatePath } from '../helpers/roles'
import { Api } from '../helpers/api'
import { Cleanup, prefix, requireWrite } from '../helpers/data'
import { seeded } from '../helpers/manifest'
import { featureOn, parseFeatures } from '../helpers/routes'

/** Bảng tin: đăng bài (UI) → hiện trong feed → xoá. */
requireWrite()
test.use({ storageState: storageStatePath('ADMIN') })

const cleanup = new Cleanup()
let api: Api
let newsfeedOn = true
test.beforeAll(async () => {
  api = await Api.forRole('ADMIN')
  newsfeedOn = featureOn(parseFeatures(await api.get('/settings/org-features').catch(() => ({}))), 'newsfeed')
})
test.beforeEach(() => {
  test.skip(!newsfeedOn, 'Tính năng Bảng tin đang tắt ở Cài đặt › Tính năng — trang hiện màn "đang tắt"')
})
test.afterAll(async () => {
  await cleanup.run()
  await api.dispose()
})

test('đăng bài và xoá bài', async ({ page }) => {
  const text = prefix('baidang')
  let id: number | null = null
  cleanup.add('xoá bài', async () => {
    if (id) await api.del(`/newsfeed/${id}`)
  })

  await page.goto('/newsfeed')
  const editor = page.locator('[contenteditable="true"]').first()
  await editor.click()
  await page.keyboard.type(text)
  await page.getByRole('button', { name: 'Đăng bài' }).click()
  await expect(page.getByText(text).first(), 'Bài vừa đăng phải hiện trong feed').toBeVisible({ timeout: 20_000 })
  await expect
    .poll(async () => {
      const r = await api.get<{ data: { id: number; content: string }[] }>('/newsfeed')
      id = r.data.find((p) => p.content.includes(text))?.id ?? null
      return id
    }, { timeout: 15_000 })
    .not.toBeNull()

  expect(await api.del(`/newsfeed/${id}`)).toBeLessThan(300)
  id = null
  await page.reload()
  await expect(page.getByText(text)).toHaveCount(0)
})

test('bình luận + thích: bài seed hiện đủ, toggle thích, xoá bình luận; người khác không xoá được bài', async ({ page }) => {
  const post = seeded('newsfeed')[0]
  test.skip(!post, 'Chưa có dữ liệu seed')
  const sale = await Api.forRole('SALE')
  const lead = await Api.forRole('LEAD')
  try {
    // Seed đã có 1 bình luận (SALE) + 1 thích (LEAD)
    const comments = await api.get<{ data: { id: number; content: string }[] }>(`/newsfeed/${post.id}/comments?limit=20`)
    expect(comments.data.some((c) => /E2E-/.test(c.content))).toBe(true)
    const feed = await api.get<{ data: { id: number; _count: { likes: number; comments: number }; liked_by_me: boolean }[] }>('/newsfeed?limit=50')
    const row = feed.data.find((p) => p.id === Number(post.id))
    expect(row, 'bài seed phải có trong feed').toBeTruthy()
    expect(row!._count.likes).toBe(1)
    expect(row!._count.comments).toBeGreaterThanOrEqual(1)
    // Thích: toggle 2 lần về trạng thái cũ
    const again = await lead.post<{ liked: boolean; like_count: number }>(`/newsfeed/${post.id}/like`)
    expect(again).toMatchObject({ liked: false, like_count: 0 })
    const back = await lead.post<{ liked: boolean; like_count: number }>(`/newsfeed/${post.id}/like`)
    expect(back).toMatchObject({ liked: true, like_count: 1 })
    // Bình luận mới của SALE rồi xoá
    const c = await sale.post<{ id: number }>(`/newsfeed/${post.id}/comments`, { content: prefix('binhluan-2') })
    expect(await sale.del(`/newsfeed/comments/${c.id}`)).toBeLessThan(300)
    // Người không phải tác giả/kiểm duyệt không xoá được bài của admin
    const forbidden = await sale.call('DELETE', `/newsfeed/${post.id}`)
    expect([403, 404], 'SALE không được xoá bài của người khác').toContain(forbidden.status())
  } finally {
    await sale.dispose()
    await lead.dispose()
  }
  await page.goto('/newsfeed')
  await expect(page.getByText(/E2E-.*baitin/).first()).toBeVisible({ timeout: 20_000 })
})
