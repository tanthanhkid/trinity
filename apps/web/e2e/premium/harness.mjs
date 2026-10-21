// Bộ chạy "cố tình phá" (docs/TRANG-THAI.md): Chrome headless RIÊNG với hồ sơ tạm, chặn MỌI lệnh gọi
// `/api/v1/*` bằng CDP `Fetch` và trả dữ liệu giả — không gọi máy chủ thật, không dùng phiên đăng nhập thật.
// Cần web đang chạy (`next dev`) ở BASE_URL. Chạy: `node e2e/premium/break-it.mjs` (xem README cùng thư mục).
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium } from "@playwright/test"

export const BASE_URL = process.env.BASE_URL ?? "http://localhost:3917"

/** JWT giả, hạn xa — đủ để proxy thấy "có phiên" và bộ hẹn làm mới token không chạy. */
export const FAKE_JWT = [
  Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ sub: 1, email: "demo@example.com", exp: 4102444800 })).toString("base64url"),
  "sig",
].join(".")

/**
 * Mở Chrome headless với hồ sơ tạm (xoá khi đóng). `channel: "chrome"` = Chrome cài sẵn trên máy, không tải trình duyệt.
 * Trả `{ browser, context, page, cdp, close }`.
 */
export async function launch({ viewport = { width: 1280, height: 800 } } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "trinity-break-"))
  const context = await chromium.launchPersistentContext(profile, {
    channel: process.env.CHROME_CHANNEL ?? "chrome",
    headless: true,
    viewport,
    locale: "vi-VN",
    timezoneId: "Asia/Ho_Chi_Minh",
    serviceWorkers: "block",
  })
  // WebSocket (thông báo thời gian thực) KHÔNG đi qua CDP Fetch ⇒ chặn riêng: mọi kết nối bị đóng ngay tại trình duyệt,
  // không tới máy chủ nào kể cả khi NEXT_PUBLIC_API_URL trỏ ra máy chủ thật (ứng dụng tự lùi về chế độ hỏi định kỳ).
  // Trừ `/_next/*` (HMR của `next dev`): chặn nó thì trang tự tải lại liên tục.
  await context.routeWebSocket((url) => !url.pathname.startsWith("/_next/"), (ws) => ws.close())
  const page = context.pages()[0] ?? (await context.newPage())
  const cdp = await context.newCDPSession(page)
  const close = async () => {
    await context.close().catch(() => {})
    rmSync(profile, { recursive: true, force: true })
  }
  return { context, page, cdp, close }
}

/** Gắn phiên giả (cookie cho proxy + localStorage cho api-client) trước khi mở trang. */
export async function signIn(context) {
  const url = new URL(BASE_URL)
  await context.addCookies([{ name: "access_token", value: FAKE_JWT, domain: url.hostname, path: "/" }])
  await context.addInitScript((jwt) => {
    localStorage.setItem("trinity_access_token", jwt)
    localStorage.setItem("trinity_refresh_token", "fake-refresh")
  }, FAKE_JWT)
}

/**
 * Chặn mọi `/api/v1/*` bằng CDP Fetch. `handler({ method, path, query, body })` trả
 * `{ status, json }` | `{ fail: "InternetDisconnected" }` | `undefined` (⇒ 404 rỗng).
 * Trả về `{ log }` — danh sách lệnh gọi đã chặn (để kiểm thử / dò endpoint).
 */
export async function mockApi(cdp, handler) {
  const log = []
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/v1/*", requestStage: "Request" }] })
  cdp.on("Fetch.requestPaused", async (ev) => {
    const u = new URL(ev.request.url)
    const path = u.pathname.replace(/^\/api\/v1/, "")
    const req = { method: ev.request.method, path, query: Object.fromEntries(u.searchParams), body: ev.request.postData }
    log.push(`${req.method} ${path}${u.search}`)
    let res
    try {
      res = await handler(req)
    } catch (e) {
      res = { status: 500, json: { message: String(e) } }
    }
    try {
      if (res?.fail) {
        await cdp.send("Fetch.failRequest", { requestId: ev.requestId, errorReason: res.fail })
        return
      }
      const status = res?.status ?? 404
      const body = res?.raw ?? JSON.stringify(res?.json ?? { message: "Not Found" })
      await cdp.send("Fetch.fulfillRequest", {
        requestId: ev.requestId,
        responseCode: status,
        responseHeaders: [{ name: "Content-Type", value: res?.contentType ?? "application/json; charset=utf-8" }],
        body: Buffer.from(body).toString("base64"),
      })
    } catch {
      /* trang đã đóng / yêu cầu đã huỷ */
    }
  })
  return { log }
}

/** Mất mạng thật ở mức trình duyệt (navigator.onLine = false, sự kiện offline) — không chỉ chặn API. */
export async function setOffline(context, offline) {
  await context.setOffline(offline)
}
