import 'reflect-metadata'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Controller, Module, Post, Req, UploadedFile, UseInterceptors } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { FileInterceptor } from '@nestjs/platform-express'
import { ELK_LOGGER, ElkExceptionFilter, LoggingInterceptor } from '@trinity/logger'
import {
  CLIENT_IP_HEADER,
  __resetClientIpStateForTest,
  __setClockForTest,
  __setRouteTableForTest,
  resolveClientIp,
  signClientIp,
} from '@trinity/rbac-nest'
import { NEST_CREATE_OPTIONS, configureApp } from '../bootstrap-app'

/**
 * Body nhỏ giọt 61 giây (đăng nhập JSON và check-in kèm ảnh multipart) đi qua ĐÚNG `configureApp` của máy chủ thật:
 * chữ ký `x-trinity-client-ip` được kiểm lúc nhận header (middleware đứng trước body-parser và multer), nên body đọc
 * xong sau 61 giây vẫn giữ IP đã kiểm — và header ký từ 61 giây trước thì bị 400 ngay.
 */

const SECRET = 's'.repeat(64)
const REAL = '203.0.113.50'
const T0 = 1_800_000_000

@Controller('t')
class ProbeController {
  @Post('login')
  login(@Req() req: http.IncomingMessage & { body?: unknown }) {
    return { ip: resolveClientIp(req as never).ip, body: req.body }
  }

  @Post('check-in')
  @UseInterceptors(FileInterceptor('selfie'))
  checkIn(@Req() req: http.IncomingMessage, @UploadedFile() selfie?: { size: number }) {
    return { ip: resolveClientIp(req as never).ip, size: selfie?.size ?? 0 }
  }
}

// Logger giả: ElkLoggerModule mở tệp log (giữ tiến trình jest sống sau khi test xong).
const noop = () => undefined
const fakeLogger = { info: noop, warn: noop, error: noop, debug: noop, log: noop }

@Module({
  controllers: [ProbeController],
  providers: [{ provide: ELK_LOGGER, useValue: fakeLogger }, LoggingInterceptor, ElkExceptionFilter],
})
class ProbeModule {}

let app: NestExpressApplication
let port: number
let clockMs = T0 * 1000
const ORIGINAL_ENV = { ...process.env }

beforeAll(async () => {
  process.env.INTERNAL_SERVICE_SECRET = SECRET
  delete process.env.TRUSTED_PROXY
  delete process.env.MULTI_TENANT
  __resetClientIpStateForTest()
  __setRouteTableForTest(null)
  __setClockForTest(() => clockMs)
  app = await NestFactory.create<NestExpressApplication>(ProbeModule, { logger: false, ...NEST_CREATE_OPTIONS })
  await configureApp(app, { serveUploads: false, swagger: false })
  await app.listen(0, '127.0.0.1')
  port = (app.getHttpServer().address() as AddressInfo).port
})

afterAll(async () => {
  await app?.close()
  __setClockForTest(null)
  __setRouteTableForTest(undefined)
  process.env = ORIGINAL_ENV
})

beforeEach(() => {
  clockMs = T0 * 1000
})

/** Gửi header + phần đầu body, chờ, đẩy đồng hồ lên `advanceSec`, rồi gửi phần còn lại. */
function trickle(
  path: string,
  headers: Record<string, string>,
  body: Buffer,
  advanceSec: number,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, method: 'POST', path, headers: { ...headers, 'content-length': String(body.length) } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString() || '{}') }))
      },
    )
    r.on('error', reject)
    const cut = Math.floor(body.length / 2)
    r.write(body.subarray(0, cut))
    setTimeout(() => {
      clockMs += advanceSec * 1000
      r.end(body.subarray(cut))
    }, 150)
  })
}

function multipart(): { body: Buffer; type: string } {
  const b = '----trinity-test-boundary'
  const head = `--${b}\r\nContent-Disposition: form-data; name="selfie"; filename="s.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`
  const body = Buffer.concat([Buffer.from(head), Buffer.alloc(4096, 1), Buffer.from(`\r\n--${b}--\r\n`)])
  return { body, type: `multipart/form-data; boundary=${b}` }
}

describe('chữ ký được kiểm lúc nhận header, không phải lúc đọc xong body', () => {
  it('đăng nhập (JSON): body nhỏ giọt 61 giây vẫn giữ IP đã ký', async () => {
    const res = await trickle(
      '/api/v1/t/login',
      { 'content-type': 'application/json', [CLIENT_IP_HEADER]: signClientIp(REAL, SECRET, T0), 'x-real-ip': '203.0.113.108' },
      Buffer.from(JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(200) })),
      61,
    )
    expect(res.status).toBe(201)
    expect(res.json.ip).toBe(REAL)
  })

  it('check-in kèm ảnh (multipart/multer): body nhỏ giọt 61 giây vẫn giữ IP đã ký', async () => {
    const { body, type } = multipart()
    const res = await trickle('/api/v1/t/check-in', { 'content-type': type, [CLIENT_IP_HEADER]: signClientIp(REAL, SECRET, T0) }, body, 61)
    expect(res.status).toBe(201)
    expect(res.json).toEqual({ ip: REAL, size: 4096 })
  })

  it('header ký 61 giây trước khi gửi (phát lại) ⇒ 400 trước khi đọc body', async () => {
    const { body, type } = multipart()
    const res = await trickle('/api/v1/t/check-in', { 'content-type': type, [CLIENT_IP_HEADER]: signClientIp(REAL, SECRET, T0 - 61) }, body, 0)
    expect(res.status).toBe(400)
  })

  it('không có header, peer loopback (TRUSTED_PROXY mặc định): x-real-ip giả không vượt được, IP không tin được', async () => {
    const res = await trickle('/api/v1/t/login', { 'content-type': 'application/json', 'x-real-ip': '203.0.113.108' }, Buffer.from('{}'), 0)
    expect(res.status).toBe(201)
    expect(res.json.ip).toBeNull()
  })
})
