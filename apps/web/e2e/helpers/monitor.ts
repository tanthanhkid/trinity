import type { Page, Response } from '@playwright/test'
import { tagKnown } from './known-issues'

/**
 * Allowlist lỗi ĐÃ BIẾT/CHẤP NHẬN — mỗi mục PHẢI có lý do. Thêm mục mới = nói rõ vì sao.
 */
export interface Allow {
  /** Khớp URL (response) hoặc text (console/pageerror). */
  pattern: RegExp
  reason: string
}

/** Console error được bỏ qua. */
export const CONSOLE_ALLOW: Allow[] = [
  {
    // Chrome in dòng này cho MỌI response 4xx/5xx; lỗi API thật đã bắt riêng ở bộ bắt response
    // (có URL + role) nên không đếm trùng.
    pattern: /Failed to load resource: the server responded with a status of/i,
    reason: 'Trùng với bộ bắt response API (có URL cụ thể hơn); tài nguyên tĩnh lỗi được bắt riêng.',
  },
  {
    pattern: /WebSocket connection .* failed|socket\.io/i,
    reason: 'Socket thông báo có thể bị chặn bởi proxy/CDN ở môi trường test; không ảnh hưởng giao diện.',
  },
]

/** Response lỗi bỏ qua (URL chứa). */
export const RESPONSE_ALLOW: Allow[] = [
  { pattern: /\/api\/fe-logging/, reason: 'Endpoint log của frontend, không phải lỗi giao diện.' },
]

export interface PageIssues {
  pageErrors: string[]
  consoleErrors: string[]
  badResponses: string[]
  failedRequests: string[]
  /** `/auth/refresh` thất bại — dấu hiệu phiên bị đá do đăng nhập song song cùng tài khoản. */
  unauthorized: string[]
}

const matches = (list: Allow[], s: string) => list.some((a) => a.pattern.test(s))

/**
 * Gắn bộ bắt lỗi vào page; trả hàm `issues()` và `reset()`.
 * - `pageerror`: lỗi JS chưa bắt — không allowlist.
 * - console `error` (trừ CONSOLE_ALLOW).
 * - response `/api/` có status ≥ 400 (trừ RESPONSE_ALLOW và 401 của `/auth/refresh` hợp lệ).
 * - request `/api/` fail (net::ERR_*) trừ abort do điều hướng.
 */
export function watchPage(page: Page) {
  const issues: PageIssues = { pageErrors: [], consoleErrors: [], badResponses: [], failedRequests: [], unauthorized: [] }

  let sawRefresh = false
  const pending401: string[] = [] // refresh đến SAU response 401 nên quyết định ở lúc đọc issues()
  page.on('request', (rq) => {
    if (/\/auth\/refresh/.test(rq.url())) sawRefresh = true
  })
  page.on('pageerror', (e) => issues.pageErrors.push(`${e.name}: ${e.message}`.slice(0, 400)))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    if (!matches(CONSOLE_ALLOW, t)) issues.consoleErrors.push(t.slice(0, 400))
  })
  page.on('response', (r: Response) => {
    const url = r.url()
    if (!/\/api\//.test(url) || r.status() < 400) return
    if (matches(RESPONSE_ALLOW, url)) return
    if (/\/auth\/refresh/.test(url)) {
      // refresh thất bại = phiên đã bị vô hiệu (đá bởi đăng nhập song song) hoặc hết hạn thật.
      issues.unauthorized.push(`${r.status()} ${r.request().method()} ${url.replace(/^https?:\/\/[^/]+/, '')}`)
      return
    }
    if (/\/auth\/login/.test(url) && r.status() === 401) return
    // 401 thường: access token 15 phút hết hạn → app tự refresh rồi gọi lại. Chỉ coi là lỗi nếu KHÔNG có refresh nào.
    if (r.status() === 401) {
      pending401.push(`401 ${r.request().method()} ${url.replace(/^https?:\/\/[^/]+/, '')}`)
      return
    }
    issues.badResponses.push(`${r.status()} ${r.request().method()} ${url.replace(/^https?:\/\/[^/]+/, '')}`)
  })
  page.on('requestfailed', (req) => {
    const url = req.url()
    if (!/\/api\//.test(url) || matches(RESPONSE_ALLOW, url)) return
    const err = req.failure()?.errorText ?? ''
    if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(err)) return // huỷ do điều hướng
    issues.failedRequests.push(`${req.method()} ${url.replace(/^https?:\/\/[^/]+/, '')} — ${err}`)
  })

  return {
    issues: () => {
      if (!sawRefresh) for (const l of pending401.splice(0)) issues.badResponses.push(l)
      else pending401.length = 0
      return issues
    },
    reset: () => {
      issues.pageErrors.length = 0
      issues.consoleErrors.length = 0
      issues.badResponses.length = 0
      issues.failedRequests.length = 0
      issues.unauthorized.length = 0
      sawRefresh = false
      pending401.length = 0
    },
  }
}

export function formatIssues(i: PageIssues, pathname = '/'): string {
  const parts: string[] = []
  if (i.pageErrors.length) parts.push(`pageerror:\n  ${[...new Set(i.pageErrors)].join('\n  ')}`)
  if (i.consoleErrors.length) parts.push(`console.error:\n  ${[...new Set(i.consoleErrors)].join('\n  ')}`)
  if (i.badResponses.length) parts.push(`API 4xx/5xx:\n  ${[...new Set(i.badResponses.map((l) => tagKnown(l, pathname)))].join('\n  ')}`)
  if (i.failedRequests.length) parts.push(`request fail:\n  ${[...new Set(i.failedRequests)].join('\n  ')}`)
  return parts.join('\n')
}

/** Tràn ngang: scrollWidth của documentElement > clientWidth (cho phép sai số 1px). */
export async function horizontalOverflow(page: Page): Promise<{ scroll: number; client: number; over: boolean }> {
  return page.evaluate(() => {
    const el = document.documentElement
    return { scroll: el.scrollWidth, client: el.clientWidth, over: el.scrollWidth > el.clientWidth + 1 }
  })
}

export const SESSION_KICKED_MSG =
  'PHIÊN BỊ ĐÁ (nhiều request 401): môi trường bật "1 phiên/tài khoản" nên ai đăng nhập CÙNG tài khoản test khi suite đang chạy sẽ vô hiệu storageState. KHÔNG phải lỗi app — đừng đăng nhập tài khoản e2e song song (hoặc dùng tài khoản e2e riêng) rồi chạy lại.'
