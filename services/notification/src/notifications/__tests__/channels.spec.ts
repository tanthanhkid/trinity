import { PushChannel, PUSH_NOT_CONFIGURED } from '../channels/push.channel'
import { WebhookChannel } from '../channels/webhook.channel'
import { isBlockedIp, parseSafeWebhookUrl } from '../channels/safe-webhook-target'

describe('PushChannel (FCM chưa tích hợp)', () => {
  it('KHÔNG báo đã gửi: trả skipped + không thử lại', async () => {
    const r = await new PushChannel().send(1, 't', 'b', { fcm_token: 'abc' })
    expect(r.success).toBe(false)
    expect(r.skipped).toBe(true)
    expect(r.retryable).toBe(false)
    expect(r.error).toBe(PUSH_NOT_CONFIGURED)
  })
  it('thiếu token → lỗi', async () => {
    expect((await new PushChannel().send(1, 't', 'b', {})).success).toBe(false)
  })
})

describe('chống SSRF webhook', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1',
    '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', 'not-an-ip',
  ])('chặn %s', (ip) => expect(isBlockedIp(ip)).toBe(true))
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('cho %s', (ip) => expect(isBlockedIp(ip)).toBe(false))

  it.each([
    'http://example.com/hook',
    'https://user:pw@example.com/hook',
    'https://example.com:22/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/x',
    'ftp://example.com',
    'khong-phai-url',
  ])('từ chối URL %s', (u) => expect(() => parseSafeWebhookUrl(u)).toThrow())
  it('nhận https công cộng', () => expect(parseSafeWebhookUrl('https://example.com/hook').hostname).toBe('example.com'))

  it('WebhookChannel không gọi mạng khi URL bị chặn, không thử lại', async () => {
    const r = await new WebhookChannel().send(1, 't', 'b', { webhook_url: 'https://127.0.0.1/hook' })
    expect(r.success).toBe(false)
    expect(r.retryable).toBe(false)
  })
})
