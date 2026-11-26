import { describe, expect, it } from "vitest"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { join } from "node:path"
import { verifyClientIpHeader } from "@/lib/client-ip-headers"

/**
 * Tệp nạp trước thật (`node --require apps/web/peer-ip.cjs`) trên socket thật: xoá header IP giả của client, ký IP peer;
 * `cloudflare-tunnel` mà sắp nghe ngoài loopback ⇒ thoát TRƯỚC khi mở cổng.
 */
const PRELOAD = join(process.cwd(), "peer-ip.cjs")
const SECRET = "s".repeat(64)

function run(script: string, env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p: ChildProcessWithoutNullStreams = spawn(process.execPath, ["--require", PRELOAD, "-e", script], {
      env: { PATH: process.env.PATH ?? "", INTERNAL_SERVICE_SECRET: SECRET, ...env } as unknown as NodeJS.ProcessEnv,
      stdio: "pipe",
    })
    let out = ""
    let err = ""
    p.stdout.on("data", (d: Buffer) => (out += d))
    p.stderr.on("data", (d: Buffer) => (err += d))
    p.on("exit", (code: number | null) => resolve({ code, out, err }))
  })
}

const SERVER = `
const http = require('node:http')
const s = http.createServer((req, res) => { res.end(JSON.stringify(req.headers)) })
s.listen(0, '127.0.0.1', () => {
  const r = http.request({ host: '127.0.0.1', port: s.address().port, headers: {
    'x-forwarded-for': '203.0.113.108', 'x-real-ip': '203.0.113.108', 'cf-connecting-ip': '203.0.113.108',
    'x-trinity-client-ip': '203.0.113.108;1;forged', 'x-trinity-peer-ip': '203.0.113.108',
    'x-trinity-signature': 't=1,v1=abc' } }, (res) => {
    let b = ''; res.on('data', (d) => b += d); res.on('end', () => { console.log(b); s.close() })
  })
  r.end()
})`

describe("peer-ip.cjs", () => {
  it("TRUSTED_PROXY=none: header giả bị bỏ, x-trinity-* của client bị xoá, IP ký là peer thật", async () => {
    const { code, out } = await run(SERVER, { TRUSTED_PROXY: "none" })
    expect(code).toBe(0)
    const headers = JSON.parse(out) as Record<string, string>
    expect(headers["x-trinity-peer-ip"]).toBeUndefined()
    // Chữ ký webhook vào (X-Trinity-Signature) KHÔNG bị xoá.
    expect(headers["x-trinity-signature"]).toBe("t=1,v1=abc")
    expect(verifyClientIpHeader(headers["x-trinity-client-ip"], { INTERNAL_SERVICE_SECRET: SECRET })).toBe("127.0.0.1")
  })

  it("cidr:127.0.0.1/32 (Caddy cùng máy): ký phần tử phải cùng của X-Forwarded-For", async () => {
    const { out } = await run(SERVER.replace("'x-forwarded-for': '203.0.113.108'", "'x-forwarded-for': '203.0.113.108, 198.51.100.4'"), { TRUSTED_PROXY: "cidr:127.0.0.1/32" })
    const headers = JSON.parse(out) as Record<string, string>
    expect(verifyClientIpHeader(headers["x-trinity-client-ip"], { INTERNAL_SERVICE_SECRET: SECRET })).toBe("198.51.100.4")
  })

  it("cloudflare-tunnel + listen mọi giao diện ⇒ thoát trước khi mở cổng", async () => {
    const { code, err } = await run("require('node:http').createServer(() => {}).listen(0, () => console.log('LISTENING'))", { TRUSTED_PROXY: "cloudflare-tunnel" })
    expect(code).toBe(1)
    expect(err).toMatch(/không phải loopback/)
  })

  it("cloudflare-tunnel + listen 127.0.0.1 ⇒ lên", async () => {
    const { code, out } = await run("const s=require('node:http').createServer(() => {}); s.listen(0, '127.0.0.1', () => { console.log('LISTENING'); s.close() })", { TRUSTED_PROXY: "cloudflare-tunnel" })
    expect(code).toBe(0)
    expect(out).toContain("LISTENING")
  })

  it("production với bí mật mẫu ⇒ không lên; TRUSTED_PROXY sai ⇒ không lên", async () => {
    expect((await run("", { NODE_ENV: "production", INTERNAL_SERVICE_SECRET: "change-me-generate-with-openssl-rand-hex-32" })).code).toBe(1)
    expect((await run("", { TRUSTED_PROXY: "yes" })).code).toBe(1)
  })

  it("header có chữ ký hợp lệ chỉ được giữ khi tới từ loopback/proxy khai báo; từ ngoài thì xác định lại từ peer", async () => {
    process.env.TRINITY_PEER_IP_NO_INSTALL = "1"
    const { createRequire } = await import("node:module")
    const preload = createRequire(import.meta.url)(PRELOAD) as {
      prepare(r: { headers: Record<string, string>; socket: { remoteAddress: string } }, e: Record<string, string>): string
      sign(v: string, e: Record<string, string>): string
    }
    const e = { INTERNAL_SERVICE_SECRET: SECRET, TRUSTED_PROXY: "none" }
    const signed = preload.sign("203.0.113.108", e)
    expect(preload.prepare({ headers: { "x-trinity-client-ip": signed }, socket: { remoteAddress: "198.51.100.9" } }, e)).toBe("198.51.100.9")
    expect(preload.prepare({ headers: { "x-trinity-client-ip": signed }, socket: { remoteAddress: "127.0.0.1" } }, e)).toBe("203.0.113.108")
  })
})
