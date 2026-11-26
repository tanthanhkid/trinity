import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const preload = path.resolve(__dirname, '../mock/block-network.cjs')

/** Chặn mạng của máy chủ Node khi chạy test hợp đồng: kết nối ra ngoài loopback bị từ chối và ghi lại. */
describe('block-network.cjs', () => {
  it('từ chối kết nối tới địa chỉ công cộng và ghi vi phạm; loopback vẫn nối được', () => {
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bn-')), 'v.txt')
    const code = `
      const net = require('node:net');
      const srv = net.createServer((s) => s.end('ok')).listen(0, '127.0.0.1', () => {
        const c = net.connect(srv.address().port, '127.0.0.1');
        c.on('data', () => { console.log('loopback-ok'); srv.close();
          const x = net.connect(443, '93.184.216.34'); x.on('error', (e) => console.log('blocked:' + e.code)); });
      });`
    const r = spawnSync(process.execPath, ['--require', preload, '-e', code], { env: { CONTRACT_NET_VIOLATIONS: log }, encoding: 'utf8' })
    expect(r.stdout).toContain('loopback-ok')
    expect(r.stdout).toContain('blocked:ECONNREFUSED')
    expect(fs.readFileSync(log, 'utf8')).toContain('connect 93.184.216.34')
  })

  it('host trong CONTRACT_NET_ALLOW (Postgres không ở loopback) không bị chặn', () => {
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bn-')), 'v.txt')
    const code = `
      const net = require('node:net');
      const x = net.connect(9, '192.0.2.1'); // TEST-NET-1: không có ai trả lời
      x.on('error', (e) => { console.log('code:' + e.code); process.exit(0) });
      setTimeout(() => { console.log('code:TIMEOUT'); process.exit(0) }, 1500);`
    const r = spawnSync(process.execPath, ['--require', preload, '-e', code], { env: { CONTRACT_NET_VIOLATIONS: log, CONTRACT_NET_ALLOW: '192.0.2.1' }, encoding: 'utf8' })
    expect(r.stdout).not.toContain('ECONNREFUSED') // không phải lỗi do bộ chặn
    expect(fs.existsSync(log)).toBe(false)
  })
})
