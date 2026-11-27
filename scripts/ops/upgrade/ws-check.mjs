#!/usr/bin/env node
/**
 * Kiểm chuông realtime qua luật reverse proxy cũ (`/notif-ws` → cổng API), dùng bởi scripts/ops/upgrade-test.sh.
 *
 *   node ws-check.mjs <base-url> <access-token> <user-id> <marker>
 *
 * Nối Socket.IO (path `/notif-ws`, namespace `/notifications/ws`, JWT ở `auth.token`), gửi một thông báo in_app cho
 * chính user đó qua `POST /api/v1/notifications/send`, rồi đo thời gian tới khi nhận `notification:new` chứa <marker>.
 * Thoát 0 nếu ≤ 1000 ms, 1 nếu chậm hoặc không tới, 2 nếu thiếu tham số. Token không bao giờ được in ra.
 */
import { io } from 'socket.io-client'

const [base, token, userIdRaw, marker] = process.argv.slice(2)
if (!base || !token || !userIdRaw || !marker) {
  console.error('usage: ws-check.mjs <base-url> <access-token> <user-id> <marker>')
  process.exit(2)
}
const userId = Number(userIdRaw)
const LIMIT_MS = 1000
const HARD_TIMEOUT_MS = 8000

const socket = io(`${base}/notifications/ws`, {
  path: '/notif-ws',
  auth: { token },
  transports: ['websocket'],
  reconnection: false,
})

let sentAt = 0
const done = (code, msg) => {
  console.log(msg)
  socket.close()
  process.exit(code)
}

const hard = setTimeout(() => done(1, `FAIL  không nhận notification:new sau ${HARD_TIMEOUT_MS} ms`), HARD_TIMEOUT_MS)

socket.on('connect_error', (e) => done(1, `FAIL  không nối được socket: ${e.message}`))
socket.on('disconnect', (reason) => {
  if (!sentAt) done(1, `FAIL  socket bị ngắt trước khi gửi (${reason}) — token bị từ chối?`)
})

socket.on('notification:new', (payload) => {
  if (!sentAt || !JSON.stringify(payload ?? {}).includes(marker)) return
  clearTimeout(hard)
  const ms = Date.now() - sentAt
  if (ms <= LIMIT_MS) done(0, `PASS  notification:new tới sau ${ms} ms`)
  else done(1, `FAIL  notification:new tới sau ${ms} ms (> ${LIMIT_MS} ms)`)
})

socket.on('connect', async () => {
  // Cho máy chủ thời gian đưa socket vào room user_<id> trước khi gửi.
  await new Promise((r) => setTimeout(r, 500))
  sentAt = Date.now()
  const res = await fetch(`${base}/api/v1/notifications/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ user_id: userId, channel: 'in_app', title: marker, body: marker }),
  }).catch((e) => ({ ok: false, status: `lỗi mạng ${e.message}` }))
  if (!res.ok) done(1, `FAIL  POST /notifications/send trả ${res.status}`)
})
