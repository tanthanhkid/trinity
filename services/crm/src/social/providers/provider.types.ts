import type { SocialNetwork } from '../social.config';

/** Một tệp đính kèm bài đăng (đã nằm trong StorageService). */
export interface SocialMedia {
  key: string;
  type: 'image' | 'video';
  content_type: string;
  size: number;
}

/** Tài khoản/trang nhận được sau OAuth — token dạng THÔ, service mã hoá trước khi lưu. */
export interface ConnectedAccount {
  external_id: string;
  name: string;
  avatar_url?: string | null;
  access_token: string;
  refresh_token?: string | null;
  token_expires_at?: Date | null;
  scopes: string[];
}

/** Tài khoản đã giải mã token, đưa cho provider lúc đăng. */
export interface AccountForPublish {
  id: number;
  external_id: string;
  name: string;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: Date | null;
}

export interface LoadedMedia extends SocialMedia {
  body: Buffer;
}

export interface PublishInput {
  text: string;
  media: SocialMedia[];
  /** Tuỳ chọn riêng của mạng (vd YouTube: title/privacy; TikTok: privacy_level). */
  options: Record<string, unknown>;
  /** Đọc nội dung tệp — chỉ gọi khi cần (tránh nạp video vào RAM nếu mạng không dùng). */
  load: (m: SocialMedia) => Promise<LoadedMedia>;
  /** Link tải công khai có chữ ký (hạn 2 giờ) — cho mạng chỉ nhận URL (Instagram). */
  publicUrl: (m: SocialMedia) => string;
}

export interface PublishResult {
  external_post_id: string;
  url: string | null;
}

/** Số liệu một bài đã đăng; null = mạng không cho lấy số đó (vd lượt xem bài chữ Facebook cần quyền insights). */
export interface PostMetrics {
  views: number | null;
  reactions: number | null;
  comments: number | null;
  shares: number | null;
  /** Bài đã bị xoá trên mạng (số giữ của lần lấy cuối, hoặc null nếu chưa lấy được lần nào). */
  removed?: boolean;
}

/** Token mới sau khi làm mới (mạng có refresh token). */
export interface RefreshedToken {
  access_token: string;
  refresh_token?: string | null;
  token_expires_at?: Date | null;
}

/**
 * Lỗi đăng đã phân loại để job quyết định: `token` ⇒ kênh cần liên kết lại (không thử lại);
 * `temporary`/`rate` ⇒ thử lại có giãn cách; `invalid`/`permission` ⇒ lỗi luôn (sửa bài/quyền rồi bấm Thử lại).
 */
export type SocialErrorKind = 'token' | 'permission' | 'rate' | 'invalid' | 'temporary';

export class SocialPublishError extends Error {
  constructor(
    readonly kind: SocialErrorKind,
    message: string,
  ) {
    super(message);
  }
  get retryable(): boolean {
    return this.kind === 'temporary' || this.kind === 'rate';
  }
}

/** Mạng báo bài/video không còn (đã bị xoá trên kênh) ⇒ thôi lấy số, giao diện hiện "đã bị xoá". */
export class SocialPostGoneError extends SocialPublishError {
  constructor(message: string) {
    super('invalid', message);
  }
}

export interface SocialProvider {
  readonly network: SocialNetwork;
  /** false = mạng chưa làm (giữ chỗ trong khung). */
  readonly supported: boolean;
  /** Đủ env (client id/secret) để liên kết. */
  configured(): boolean;
  /** Tên biến môi trường cần đặt — hiện ở màn Kênh khi chưa cấu hình. */
  readonly envNames: readonly string[];
  readonly scopes: readonly string[];
  /** Kiểm tệp đính kèm hợp với mạng; trả thông điệp lỗi tiếng Việt hoặc null. */
  validateMedia(media: SocialMedia[]): string | null;
  /** Kiểm tuỳ chọn riêng của mạng (vd YouTube: tiêu đề, quyền xem) với nội dung sẽ đăng; trả lỗi tiếng Việt hoặc null. */
  validateOptions?(text: string, options: Record<string, unknown>): string | null;
  authorizeUrl(state: string, redirectUri: string, pkceChallenge?: string): string;
  /** Mạng dùng PKCE (X, TikTok…) */
  readonly usesPkce: boolean;
  exchange(code: string, redirectUri: string, verifier?: string): Promise<ConnectedAccount[]>;
  /** Làm mới token sắp hết hạn; null = mạng không cần (token trang FB không hết hạn). */
  refresh?(account: AccountForPublish): Promise<RefreshedToken | null>;
  publish(account: AccountForPublish, input: PublishInput): Promise<PublishResult>;
  /** Gỡ bài đã đăng trên mạng (nếu mạng cho phép). */
  deletePost?(account: AccountForPublish, externalPostId: string): Promise<void>;
  /** Số liệu bài đã đăng (lượt xem, cảm xúc/thích, bình luận, chia sẻ). */
  fetchMetrics?(account: AccountForPublish, externalPostId: string): Promise<PostMetrics>;
}
