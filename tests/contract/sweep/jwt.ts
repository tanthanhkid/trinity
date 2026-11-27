import { createHmac } from 'node:crypto'

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')

/** Token HS256 giống `jwtService.sign({ sub, email })` của Nest, ký bằng `JWT_SECRET` RIÊNG của máy quét (không bao giờ là của bản thật). */
export function signToken(
  secret: string,
  claims: { sub: number; email: string; cid?: number },
  ttlSec = 3600,
  nowSec = Math.floor(Date.now() / 1000),
): string {
  if (secret.length < 32) throw new Error('SWEEP_JWT_SECRET phải dài ≥ 32 ký tự')
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64({ ...claims, iat: nowSec, exp: nowSec + ttlSec })
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}
