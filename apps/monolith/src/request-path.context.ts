import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Đường dẫn của request đang xử lý, để `ServiceAwareValidationPipe` biết route
 * này thuộc service cũ nào.
 *
 * Vì sao phải qua AsyncLocalStorage: NestJS truyền cho pipe đúng
 * `ArgumentMetadata` (kiểu DTO, vị trí tham số) — KHÔNG có request. Middleware
 * chạy TRƯỚC pipe nên đây là chỗ sớm nhất lấy được đường dẫn.
 */
export const requestPathStorage = new AsyncLocalStorage<string>()

/** Middleware Express thuần — đăng ký bằng `app.use()` trước mọi thứ khác. */
export function requestPathMiddleware(
  req: { url?: string },
  _res: unknown,
  next: () => void,
): void {
  const path = typeof req.url === 'string' ? req.url.split('?')[0] : ''
  requestPathStorage.run(path, next)
}
