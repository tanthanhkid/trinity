import { Injectable, Logger } from '@nestjs/common'
import { request } from 'node:https'
import { NotificationChannel, DeliveryResult } from './channel.interface'
import { createSafeLookup, parseSafeWebhookUrl } from './safe-webhook-target'

const WEBHOOK_TIMEOUT_MS = 5000

@Injectable()
export class WebhookChannel implements NotificationChannel {
  private readonly logger = new Logger(WebhookChannel.name)

  async send(
    recipientId: number,
    title: string,
    body: string,
    metadata?: Record<string, unknown>,
  ): Promise<DeliveryResult> {
    const webhookUrl = metadata?.['webhook_url']
    if (typeof webhookUrl !== 'string' || !webhookUrl) {
      return { success: false, error: 'Khong co webhook URL' }
    }

    let url: URL
    try {
      url = parseSafeWebhookUrl(webhookUrl)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'URL khong hop le'
      this.logger.warn(`Webhook bi chan: ${message}`)
      return { success: false, error: message, retryable: false }
    }

    const payload = JSON.stringify({
      recipient_id: recipientId,
      title,
      body,
      timestamp: new Date().toISOString(),
    })

    try {
      const status = await this.post(url, payload)
      if (status < 200 || status >= 300) {
        // Redirect (3xx) cũng bị coi là lỗi: không bao giờ đi theo, tránh vòng qua đích nội bộ.
        return { success: false, error: `HTTP ${status}` }
      }
      this.logger.log(`Webhook sent to ${url.origin}`)
      return { success: true, messageId: `webhook_${Date.now()}` }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      this.logger.error(`Webhook failed: ${message}`)
      return { success: false, error: message }
    }
  }

  /** POST JSON, timeout cứng, không theo redirect, kết nối qua lookup đã kiểm SSRF. */
  private post(url: URL, payload: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
          lookup: createSafeLookup() as never,
          timeout: WEBHOOK_TIMEOUT_MS,
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on('timeout', () => req.destroy(new Error(`Webhook timeout sau ${WEBHOOK_TIMEOUT_MS}ms`)))
      req.on('error', reject)
      req.end(payload)
    })
  }
}
