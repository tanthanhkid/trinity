import { describe, it, expect, vi } from 'vitest'
import { resolveWsBaseUrl } from '@/lib/ws-url'

/**
 * Tests cho hàm suy ra origin socket thông báo (`lib/ws-url.ts`), dùng bởi
 * `components/notification-socket.tsx`.
 *
 * Test import đúng hàm production. Lưu ý: `new URL('not-a-valid-url-:::/', base)`
 * không ném lỗi mà trả origin opaque (chuỗi `"null"`), nên hàm phải tự kiểm
 * kết quả thay vì chỉ dựa vào `catch`.
 */
describe('resolveWsBaseUrl', () => {
  const ORIGIN = 'https://crm.example.com'

  it('relative path ("/api/v1") → trả về origin của window', () => {
    expect(resolveWsBaseUrl('/api/v1', ORIGIN)).toBe(ORIGIN)
  })

  it('absolute URL ("https://other.com/api/v1") → trả về origin của URL đó', () => {
    expect(resolveWsBaseUrl('https://other.com/api/v1', ORIGIN)).toBe('https://other.com')
  })

  it('undefined env → trả về window.location.origin', () => {
    expect(resolveWsBaseUrl(undefined, ORIGIN)).toBe(ORIGIN)
  })

  it('chuỗi rỗng → trả về window.location.origin', () => {
    expect(resolveWsBaseUrl('', ORIGIN)).toBe(ORIGIN)
  })

  it('invalid string không parse được → fallback về origin', () => {
    expect(resolveWsBaseUrl('not-a-valid-url-:::/', ORIGIN)).toBe(ORIGIN)
  })

  // ---------------------------------------------------------------------
  // 🔴 Nhóm ca đã gây — `new URL()` KHÔNG throw, trả chuỗi "null"
  // ---------------------------------------------------------------------
  it.each([
    ['localhost:8080', 'host:port thiếu scheme — dạng hay gõ nhầm trong .env.local'],
    ['api-host:8080', 'tên service nội bộ thiếu scheme'],
    ['ftp://example.com', 'protocol không phải http/https'],
  ])('env "%s" (%s) → KHÔNG BAO GIỜ trả "null", fallback về origin', (raw) => {
    const result = resolveWsBaseUrl(raw, ORIGIN)
    expect(result).not.toBe('null')
    expect(result).toBe(ORIGIN)
  })

  it('bằng chứng hồi quy: new URL() trả CHUỖI "null" chứ không ném lỗi', () => {
    // Khoá lại đúng tiền đề sai của bản cũ — nếu engine đổi hành vi, test này
    // đỏ và nhắc đọc lại `lib/ws-url.ts`.
    const parsed = new URL('localhost:8080', ORIGIN)
    expect(parsed.origin).toBe('null')
    expect(parsed.protocol).toBe('localhost:')
  })

  it('env sai → gọi onReject kèm lý do (không nuốt im lặng)', () => {
    const onReject = vi.fn()
    resolveWsBaseUrl('localhost:8080', ORIGIN, onReject)
    expect(onReject).toHaveBeenCalledTimes(1)
    expect(onReject.mock.calls[0][0]).toContain('localhost:8080')
  })

  it('env hợp lệ → KHÔNG gọi onReject', () => {
    const onReject = vi.fn()
    resolveWsBaseUrl('https://other.com/api/v1', ORIGIN, onReject)
    expect(onReject).not.toHaveBeenCalled()
  })

  // Giữ NGUYÊN hành vi bản cũ: khi SSR (origin '') mà env có giá trị, bản cũ
  // mượn base 'http://localhost' rồi trả origin đó — KHÔNG trả ''. Chỉ nhánh
  // `!apiUrl` mới trả ''. Khoá lại để bản refactor không lệch.
  it('SSR (origin rỗng) + env relative → mượn base localhost như bản cũ', () => {
    expect(resolveWsBaseUrl('/api/v1', '')).toBe('http://localhost')
  })

  it('SSR (origin rỗng) + env không set → chuỗi rỗng như bản cũ', () => {
    expect(resolveWsBaseUrl(undefined, '')).toBe('')
  })

  // Chính TRANG cũng có thể có origin opaque (`about:blank`, iframe sandbox,
  // `file://` trên Firefox) — khi đó `window.location.origin` LÀ chuỗi "null".
  // Trả nó ra là tái lập đúng lỗi đang sửa, chỉ khác nguồn.
  it.each([undefined, '/api/v1', 'localhost:8080'])(
    'origin của TRANG là "null" (env=%s) → KHÔNG trả "null" ra ngoài',
    (raw) => {
      expect(resolveWsBaseUrl(raw, 'null')).not.toBe('null')
    },
  )
})
