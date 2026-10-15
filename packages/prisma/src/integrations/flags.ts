/**
 * Cờ bật/tắt tích hợp — MẶC ĐỊNH TẮT (bất biến #4: job/worker mới merge/deploy phải INERT).
 * Đọc env MỖI LẦN gọi (không cache module-level) để test đổi được và để quản trị đổi `.env` + restart là đủ.
 * Chỉ giá trị 'true' / '1' (không phân biệt hoa thường) mới bật.
 */
const on = (v: string | undefined): boolean => v !== undefined && ['true', '1'].includes(v.trim().toLowerCase())

export const integrationFlags = {
  webhooksEnabled: (env: NodeJS.ProcessEnv = process.env): boolean => on(env.INTEGRATIONS_WEBHOOKS_ENABLED),
  mcpEnabled: (env: NodeJS.ProcessEnv = process.env): boolean => on(env.INTEGRATIONS_MCP_ENABLED),
  /** Có ít nhất một kênh bật — điều kiện chạy job dọn outbox + mở route nhật ký. */
  anyEnabled: (env: NodeJS.ProcessEnv = process.env): boolean => on(env.INTEGRATIONS_WEBHOOKS_ENABLED) || on(env.INTEGRATIONS_MCP_ENABLED),
}
