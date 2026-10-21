import axios from "axios"

/* =============================================================================
 * Bảng thông điệp lỗi dùng chung (xem docs/TRANG-THAI.md mục "Chữ lỗi").
 * Mỗi loại lỗi nói: chuyện gì xảy ra + người dùng làm gì tiếp. Tiếng Việt, không lộ kỹ thuật
 * (không mã HTTP, không chữ tiếng Anh của máy chủ, không tên giao thức).
 * Màn hình chỉ thêm phần "việc gì không làm được" ("Không lưu được"), phần còn lại lấy từ đây.
 * ========================================================================== */

export type ErrorKind =
  | "network"
  | "timeout"
  | "session"
  | "forbidden"
  | "notFound"
  | "conflict"
  | "validation"
  | "tooLarge"
  | "rateLimited"
  | "server"
  | "maintenance"
  | "unknown"

export interface ErrorCopy {
  /** Chuyện gì xảy ra — một câu ngắn, viết hoa chữ đầu. */
  title: string
  /** Cách sửa / việc nên làm tiếp. */
  hint: string
  /** Bấm "Thử lại" có ích không (hết quyền / hết phiên thì không). */
  retry: boolean
}

export const ERROR_MESSAGES: Record<ErrorKind, ErrorCopy> = {
  network: { title: "Không kết nối được máy chủ", hint: "Kiểm tra Internet rồi thử lại.", retry: true },
  timeout: { title: "Máy chủ phản hồi quá lâu", hint: "Thử lại sau ít phút.", retry: true },
  session: { title: "Phiên đăng nhập đã hết hạn", hint: "Đăng nhập lại để tiếp tục — dữ liệu đã lưu không mất.", retry: false },
  forbidden: { title: "Tài khoản của bạn chưa có quyền làm việc này", hint: "Nhờ quản trị viên cấp quyền ở Cài đặt › Vai trò.", retry: false },
  notFound: { title: "Không tìm thấy dữ liệu", hint: "Có thể mục này đã bị xoá hoặc chuyển cho người khác — tải lại để xem bản mới nhất.", retry: true },
  conflict: { title: "Dữ liệu vừa được người khác thay đổi", hint: "Tải lại để xem bản mới nhất rồi làm lại.", retry: true },
  validation: { title: "Thông tin chưa hợp lệ", hint: "Kiểm tra lại các ô đã nhập.", retry: false },
  tooLarge: { title: "Tệp quá lớn", hint: "Chọn tệp nhỏ hơn hoặc nén lại rồi tải lên.", retry: false },
  rateLimited: { title: "Bạn thao tác hơi nhanh", hint: "Đợi khoảng một phút rồi thử lại.", retry: true },
  server: { title: "Máy chủ đang gặp sự cố", hint: "Thử lại sau ít phút; vẫn lỗi thì báo quản trị viên kèm thời điểm xảy ra.", retry: true },
  maintenance: { title: "Hệ thống đang bảo trì hoặc khởi động lại", hint: "Thử lại sau vài phút.", retry: true },
  unknown: { title: "Có trục trặc ngoài dự kiến", hint: "Thử lại; vẫn lỗi thì tải lại trang.", retry: true },
}

/** "Tiêu đề. Gợi ý." — câu đầy đủ của một loại lỗi. */
export const errorSentence = (kind: ErrorKind): string => `${ERROR_MESSAGES[kind].title}. ${ERROR_MESSAGES[kind].hint}`

type HttpError = { code?: string; response?: { status?: number; data?: unknown } }

/** Lỗi gọi API: lỗi axios, hoặc vật có `response` cùng hình (một số chỗ tự dựng lỗi kiểu này). */
export function isHttpError(err: unknown): err is HttpError {
  return axios.isAxiosError(err) || (typeof err === "object" && err !== null && "response" in err)
}

/** Phân loại lỗi từ axios (hoặc lỗi bất kỳ). Lỗi không phải gọi API ⇒ `unknown`. */
export function errorKind(err: unknown): ErrorKind {
  if (!isHttpError(err)) return "unknown"
  if (!err.response) return err.code === "ECONNABORTED" || err.code === "ETIMEDOUT" ? "timeout" : "network"
  const s = err.response.status ?? 0
  if (s === 401) return "session"
  if (s === 403) return "forbidden"
  if (s === 404) return "notFound"
  if (s === 408 || s === 504) return "timeout"
  if (s === 409 || s === 412) return "conflict"
  if (s === 413) return "tooLarge"
  if (s === 429) return "rateLimited"
  if (s === 502 || s === 503) return "maintenance"
  if (s >= 500) return "server"
  if (s >= 400) return "validation"
  return "unknown"
}

/** Có dấu tiếng Việt ⇒ câu do máy chủ viết cho người dùng (NestJS/thư viện trả tiếng Anh hoặc mã như "CONTACT_NOT_FOUND"). */
const VIETNAMESE = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i

/** Câu giải thích tiếng Việt do máy chủ gửi kèm lỗi (nếu có) — cụ thể hơn câu chung nên được ưu tiên. */
export function serverSentence(err: unknown): string | null {
  if (!isHttpError(err)) return null
  const data = err.response?.data as { error?: unknown; message?: unknown } | undefined
  const parts = [data?.message, data?.error]
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter((v): v is string => typeof v === "string" && VIETNAMESE.test(v))
  return parts.length ? [...new Set(parts)].join("; ") : null
}

/** Bỏ đuôi "vui lòng thử lại" của câu màn hình truyền vào — phần gợi ý đã có trong bảng, tránh nói hai lần. */
const stripRetryTail = (s: string) => s.replace(/[,.;:\s—-]*(vui lòng\s+)?thử lại(\s+sau)?\.?\s*$/i, "").trim()

/**
 * Câu lỗi cho người dùng: "<việc không làm được>: <chuyện gì>. <cách sửa>".
 * Máy chủ có câu tiếng Việt ⇒ dùng nguyên câu đó. Lỗi không phải từ máy chủ ⇒ giữ câu màn hình truyền vào.
 */
export function describeError(err: unknown, action?: string): string {
  const own = serverSentence(err)
  if (own) return own
  if (!isHttpError(err)) return action ?? errorSentence("unknown")
  const kind = errorKind(err)
  const lead = action ? stripRetryTail(action) : ""
  if (!lead) return errorSentence(kind)
  // Câu màn hình đã tự giải thích cách sửa ("Không đọc được file. Kiểm tra đúng mẫu…") ⇒ với lỗi dữ liệu / lỗi khác,
  // câu chung chỉ lặp lại ý kém hơn; mất mạng / máy chủ / quyền… thì vẫn nói thêm nguyên nhân thật.
  if (/[.!?]\s+\S/.test(lead) && (kind === "validation" || kind === "unknown")) return lead
  const { title, hint } = ERROR_MESSAGES[kind]
  return `${lead}: ${title.charAt(0).toLowerCase()}${title.slice(1)}. ${hint}`
}

/**
 * Câu lỗi cho một thao tác (`fallback` = "Không lưu được"…). Lỗi không phải gọi API, hoặc yêu cầu bị huỷ ⇒ giữ nguyên `fallback`.
 * `getApiErrorMessage` (lib/api-client) và các hàm lỗi riêng từng mô-đun đều đi qua đây.
 */
export function errorMessage(err: unknown, fallback: string): string {
  if (!isHttpError(err) || err.code === "ERR_CANCELED") return fallback
  return describeError(err, fallback)
}
