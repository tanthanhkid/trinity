import { describe, it, expect } from 'vitest'
import { pathOnly, originOnly, scrubText, scrubPostHogEvent, scrubSentryEvent, scrubBreadcrumb, stripQuery } from '@/lib/monitoring-filters'

describe('pathOnly', () => {
  it('bỏ query/hash, thay số và uuid bằng :id', () => {
    expect(pathOnly('https://crm.example.com/contacts/123/edit?search=a&x=1#top')).toBe('/contacts/:id/edit')
    expect(pathOnly('/deals/550e8400-e29b-41d4-a716-446655440000?tab=1')).toBe('/deals/:id')
    expect(pathOnly('/settings/billing')).toBe('/settings/billing')
    expect(pathOnly(undefined)).toBe('')
  })
})

describe('originOnly', () => {
  it('chỉ giữ origin', () => {
    expect(originOnly('https://www.google.com/search?q=abc')).toBe('https://www.google.com')
    expect(originOnly('')).toBe('')
    expect(originOnly('not a url')).toBe('')
  })
})

describe('scrubText / stripQuery', () => {
  it('che email và số điện thoại, giữ số ngắn', () => {
    expect(scrubText('lỗi a.b@x.vn và 0901 234 567, mã 500')).toBe('lỗi [email] và [phone], mã 500')
    expect(stripQuery('/a/b?c=d#e')).toBe('/a/b')
  })
})

describe('scrubPostHogEvent', () => {
  it('rút gọn URL, referrer, các $initial_*', () => {
    const e = scrubPostHogEvent({
      properties: {
        $current_url: 'https://crm.example.com/contacts/42?q=nguyen',
        $pathname: '/contacts/42',
        $referrer: 'https://www.google.com/search?q=secret',
        $initial_current_url: 'https://crm.example.com/deals/7?utm=x',
        $initial_referrer: 'https://news.example.org/a/b?c=d',
        other: 'giu',
      },
    })
    expect(e.properties).toMatchObject({
      $current_url: '/contacts/:id',
      $pathname: '/contacts/:id',
      $referrer: 'https://www.google.com',
      $initial_current_url: '/deals/:id',
      $initial_referrer: 'https://news.example.org',
      other: 'giu',
    })
  })
  it('null và event không có properties đi qua nguyên vẹn', () => {
    expect(scrubPostHogEvent(null)).toBeNull()
    expect(scrubPostHogEvent({})).toEqual({})
  })
})

describe('scrubSentryEvent', () => {
  it('xoá headers/query, che message, bỏ breadcrumb console và ui.input', () => {
    const ev = scrubSentryEvent({
      request: { url: 'https://crm.example.com/x?token=1', headers: { a: 'b' }, query_string: 'token=1', cookies: {}, data: {} },
      message: 'a@b.com failed',
      exception: { values: [{ value: 'call 0912345678' }] },
      breadcrumbs: [
        { category: 'console', message: 'x' },
        { category: 'ui.input', message: 'typed' },
        { category: 'fetch', data: { url: '/api/v1/contacts?search=zz' } },
      ],
      user: { id: 'h', email: 'a@b.c' },
    })
    expect(ev.request).toEqual({ url: 'https://crm.example.com/x' })
    expect(ev.message).toBe('[email] failed')
    expect(ev.exception?.values?.[0].value).toBe('call [phone]')
    expect(ev.breadcrumbs).toEqual([{ category: 'fetch', data: { url: '/api/v1/contacts' } }])
    expect(ev.user).toEqual({ id: 'h' })
  })
  it('scrubBreadcrumb trả null cho console', () => {
    expect(scrubBreadcrumb({ category: 'console' })).toBeNull()
  })
})
