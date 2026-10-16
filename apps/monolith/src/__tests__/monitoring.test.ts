import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initMonitoring, resetMonitoringForTest } from '../monitoring'
import { scrubEvent, scrubText, scrubUrl, scrubBreadcrumbs } from '../monitoring-filters'

describe('initMonitoring', () => {
  beforeEach(() => resetMonitoringForTest())
  test('không có biến nào → false, không lỗi, idempotent', () => {
    assert.equal(initMonitoring({}), false)
    assert.equal(initMonitoring({ SENTRY_DSN: 'https://x@y.example/1' }), false) // đã chạy: giữ kết quả cũ
  })
  test('chỉ có secret (JWT_SECRET) → vẫn false', () => {
    assert.equal(initMonitoring({ JWT_SECRET: 'abc' }), false)
  })
  test('PostHog bật khi có key + secret', () => {
    assert.equal(initMonitoring({ POSTHOG_KEY: 'phc_x', JWT_SECRET: 'abc' }), true)
  })
})

describe('scrubText', () => {
  test('che email và số điện thoại', () => {
    assert.equal(scrubText('lỗi với a.b+c@x.vn gọi 0901 234 567 nhé'), 'lỗi với [email] gọi [phone] nhé')
    assert.equal(scrubText('+84 90-123-4567'), '[phone]')
  })
  test('giữ số ngắn', () => {
    assert.equal(scrubText('status 500 sau 1234 ms'), 'status 500 sau 1234 ms')
  })
})

describe('scrubUrl', () => {
  test('bỏ query, che token đường dẫn', () => {
    assert.equal(scrubUrl('/api/v1/contacts?search=nguyen&page=2'), '/api/v1/contacts')
    assert.equal(scrubUrl('/api/v1/hooks/in/secrettoken?x=1'), '/api/v1/hooks/in/[redacted]')
    assert.equal(scrubUrl(undefined), undefined)
  })
})

describe('scrubEvent', () => {
  test('xoá request data/cookies/headers/query, user chỉ còn id, che message', () => {
    const ev = scrubEvent({
      request: { url: 'https://h.example/api/v1/x?token=abc', data: { a: 1 }, cookies: { s: 'x' }, headers: { authorization: 'b' }, query_string: 'token=abc', method: 'POST' },
      user: { id: 'h1', email: 'a@b.com', ip_address: '1.2.3.4' },
      message: 'fail for a@b.com',
      exception: { values: [{ value: 'phone 0912345678 invalid' }] },
      breadcrumbs: [
        { category: 'console', message: 'secret' },
        { category: 'http', data: { url: 'https://h.example/a?b=c' } },
      ],
    })
    assert.deepEqual(ev.request, { url: 'https://h.example/api/v1/x', method: 'POST' })
    assert.deepEqual(ev.user, { id: 'h1' })
    assert.equal(ev.message, 'fail for [email]')
    assert.equal(ev.exception?.values?.[0].value, 'phone [phone] invalid')
    assert.equal(ev.breadcrumbs?.length, 1)
    assert.equal(ev.breadcrumbs?.[0].data?.url, 'https://h.example/a')
  })
  test('user không có id → rỗng', () => {
    assert.deepEqual(scrubEvent({ user: { email: 'a@b.c' } }).user, {})
  })
  test('scrubBreadcrumbs bỏ console', () => {
    assert.equal(scrubBreadcrumbs([{ category: 'console' }]).length, 0)
  })
})
