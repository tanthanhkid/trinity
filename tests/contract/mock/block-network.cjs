/**
 * Nạp bằng `--require` cho máy chủ Node khi chạy test hợp đồng: chặn mọi kết nối TCP và tra DNS tới địa chỉ KHÔNG phải loopback
 * (chặn mạng, không lời gọi nào ra Internet). Vi phạm được ghi vào tệp `CONTRACT_NET_VIOLATIONS`; bộ chạy đọc tệp này sau mỗi hồ sơ.
 */
const fs = require('node:fs')
const net = require('node:net')
const dns = require('node:dns')

const file = process.env.CONTRACT_NET_VIOLATIONS
const loopback = (h) => {
  const x = String(h || '').toLowerCase().replace(/^\[|\]$/g, '')
  return x === '' || x === 'localhost' || x === '::1' || x === '::' || x === '0.0.0.0' || /^127(\.\d{1,3}){3}$/.test(x) || x.startsWith('/')
}
const record = (kind, host) => {
  try {
    if (file) fs.appendFileSync(file, `${kind} ${host}\n`)
  } catch {
    /* không ghi được thì vẫn chặn */
  }
}

const origConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  // `net.connect` truyền mảng đã chuẩn hoá `[options, cb]` (có ký hiệu nội bộ) thay vì `options`.
  const a = Array.isArray(args[0]) ? args[0][0] : args[0]
  const host = a && typeof a === 'object' ? a.host : typeof args[1] === 'string' ? args[1] : undefined
  const isPath = a && typeof a === 'object' ? Boolean(a.path) : typeof a === 'string'
  if (!isPath && !loopback(host)) {
    record('connect', host)
    const err = Object.assign(new Error(`Chặn mạng (test hợp đồng): ${host}`), { code: 'ECONNREFUSED' })
    process.nextTick(() => this.destroy(err))
    return this
  }
  return origConnect.apply(this, args)
}

const origLookup = dns.lookup
dns.lookup = function (hostname, ...rest) {
  if (!loopback(hostname)) {
    record('dns', hostname)
    const cb = rest[rest.length - 1]
    const err = Object.assign(new Error(`Chặn mạng (test hợp đồng): ${hostname}`), { code: 'ENOTFOUND' })
    if (typeof cb === 'function') return process.nextTick(cb, err)
  }
  return origLookup.call(this, hostname, ...rest)
}
