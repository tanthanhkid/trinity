import { test, expect } from '@playwright/test'
import { Api } from '../helpers/api'
import { requireWrite } from '../helpers/data'
import { recordSoft } from '../helpers/manifest'

/**
 * CHẤM CÔNG — đơn: SALE tạo → LEAD (team) / DEPT_HEAD (subtree) / HR (all) thấy trong phạm vi → người có
 * `attendance.manage` duyệt / từ chối → SALE thấy kết quả. SALE không tự duyệt được. Đơn không có API xoá
 * ⇒ ghi residual (bảng `attendance_requests`). Dùng loại `late_arrival` (duyệt không đổi bản ghi công).
 */
requireWrite()
test.describe.configure({ mode: 'serial' })

const day = (offset: number) => new Date(Date.now() + 7 * 3600_000 - offset * 86400_000).toISOString().slice(0, 10)
let sale: Api, lead: Api, dept_head: Api, hr: Api
let reqA = 0
let reqB = 0

test.beforeAll(async () => {
  ;[sale, lead, dept_head, hr] = await Promise.all([Api.forRole('SALE'), Api.forRole('LEAD'), Api.forRole('DEPT_HEAD'), Api.forRole('HR')])
})
test.afterAll(async () => {
  await Promise.all([sale, lead, dept_head, hr].map((a) => a.dispose()))
})

type Req = { id: number; status: string; reason: string; review_note: string | null; user_id: number }
const listPending = async (a: Api) => (await a.get<{ data: Req[] }>('/management/attendance/requests?status=pending&page_size=500')).data

test('SALE tạo 2 đơn; cấp trên trong phạm vi thấy, SALE không tự duyệt được', async () => {
  const seedN = Math.floor((Date.now() / 1000) % 150) + 20
  const mk = async (offset: number, tag: string) => {
    const r = await sale.post<Req>('/management/attendance/requests', { work_date: day(offset), type: 'late_arrival', reason: `E2E-${Date.now()}-${tag}` })
    recordSoft('attendance-request', r.id, r.reason, 'attendance_requests (+ notifications gửi cho người duyệt)', 'đơn chấm công không có API xoá')
    expect(r.status).toBe('pending')
    return r
  }
  reqA = (await mk(seedN, 'duyet')).id
  reqB = (await mk(seedN + 1, 'tuchoi')).id

  for (const [name, a] of [['LEAD (team)', lead], ['DEPT_HEAD (subtree)', dept_head], ['HR (all)', hr]] as const) {
    const ids = (await listPending(a)).map((r) => r.id)
    expect(ids, `${name} phải thấy đơn của SALE`).toEqual(expect.arrayContaining([reqA, reqB]))
  }
  expect((await sale.call('POST', `/management/attendance/requests/${reqA}/approve`)).status(), 'SALE không có attendance.manage → 403').toBe(403)
})

test('LEAD duyệt đơn A; DEPT_HEAD từ chối đơn B kèm ghi chú; SALE thấy kết quả', async () => {
  const ok = await lead.call('POST', `/management/attendance/requests/${reqA}/approve`)
  expect(ok.status()).toBeLessThan(300)
  const no = await dept_head.call('POST', `/management/attendance/requests/${reqB}/reject`, { review_note: 'E2E từ chối' })
  expect(no.status()).toBeLessThan(300)
  const mine = (await sale.get<{ data: Req[] }>('/management/attendance/requests?page_size=500')).data
  expect(mine.find((r) => r.id === reqA)?.status).toBe('approved')
  const b = mine.find((r) => r.id === reqB)
  expect(b?.status).toBe('rejected')
  expect(b?.review_note).toBe('E2E từ chối')
  // Đã xử lý → duyệt lại bị chặn
  expect((await lead.call('POST', `/management/attendance/requests/${reqA}/approve`)).status()).toBe(400)
  // Không còn trong hàng chờ
  expect((await listPending(hr)).map((r) => r.id)).not.toEqual(expect.arrayContaining([reqA]))
})

test('đơn thiếu giờ khi quên chấm công → 400; ngày sai định dạng → 400', async () => {
  expect((await sale.call('POST', '/management/attendance/requests', { work_date: day(5), type: 'forgot_check_in', reason: 'E2E-thieu-gio' })).status()).toBe(400)
  expect((await sale.call('POST', '/management/attendance/requests', { work_date: '31/12/2026', type: 'leave', reason: 'E2E-sai-ngay' })).status()).toBe(400)
})

test('SALE mở trang Chấm công cá nhân và HR mở Quản lý chấm công không lỗi', async ({ browser }) => {
  for (const [role, path, h1] of [['SALE', '/attendance', /Chấm công/], ['HR', '/management/workdays', /Quản lý chấm công/]] as const) {
    const ctx = await browser.newContext({ storageState: `e2e/.auth/${role.toLowerCase()}.json` })
    const page = await ctx.newPage()
    const errs: string[] = []
    page.on('pageerror', (e) => errs.push(e.message))
    await page.goto(path)
    await expect(page.getByRole('heading', { name: h1 }).first()).toBeVisible({ timeout: 20_000 })
    expect(errs, `pageerror trên ${path}`).toEqual([])
    await ctx.close()
  }
})
