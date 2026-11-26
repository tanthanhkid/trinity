/**
 * API điều khiển test (C18): chỉ tồn tại khi `TRINITY_TEST_HOOKS=1` **và** `NODE_ENV` khác `production`. Cờ này cũng là
 * công tắc tắt mọi lịch tự động (setInterval của job, @Cron, migrate nền): job chỉ chạy khi ca test gọi qua API.
 */
export function testHooksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // NODE_ENV phải được đặt rõ là test/development: chưa đặt (cấu hình sót) không đủ để mở API này.
  return (env.TRINITY_TEST_HOOKS ?? '').trim() === '1' && (env.NODE_ENV === 'test' || env.NODE_ENV === 'development')
}
