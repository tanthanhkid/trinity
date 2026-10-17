import { Injectable, Logger } from '@nestjs/common';
import { loadFacebookConfig } from './facebook.config';

export class GraphApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: number | null,
    readonly subcode: number | null,
    message: string,
  ) {
    super(message);
  }
  /** 190 = token hết hạn/bị thu hồi. */
  get isTokenError(): boolean {
    return this.code === 190;
  }
  /** 10 / 200-299 = thiếu quyền. */
  get isPermissionError(): boolean {
    return this.code === 10 || (this.code !== null && this.code >= 200 && this.code < 300);
  }
  /** 4/17/32/613 hoặc HTTP 429 = giới hạn tần suất — tạm thời, phải để Meta gửi lại. */
  get isRateLimit(): boolean {
    return this.httpStatus === 429 || (this.code !== null && [4, 17, 32, 613].includes(this.code));
  }
  /** 1545041 / 10 (subcode 2018278) = ngoài cửa sổ nhắn tin. */
  get isOutsideWindow(): boolean {
    return this.subcode === 2018278 || this.code === 1545041;
  }
}

export interface GraphPage {
  id: string;
  name: string;
  access_token: string;
  /** Việc người dùng làm được trên Page (CREATE_CONTENT, MANAGE, MESSAGING…). */
  tasks?: string[];
  picture?: { data?: { url?: string } };
}

export interface TokenDebug {
  is_valid: boolean;
  /** 0 / undefined = không hết hạn */
  expires_at?: number;
  data_access_expires_at?: number;
}

export interface LeadData {
  id: string;
  created_time?: string;
  form_id?: string;
  ad_id?: string;
  field_data?: Array<{ name: string; values: string[] }>;
}

type Query = Record<string, string | undefined>;

/**
 * Client Graph API mỏng (fetch) — 1 chỗ duy nhất gọi Meta, test thay bằng mock. Token gửi bằng header
 * `Authorization: Bearer` (không nằm trong URL ⇒ không lọt vào log truy cập). KHÔNG BAO GIỜ log token/secret.
 * Docs: https://developers.facebook.com/docs/graph-api/overview
 */
export interface GraphConversationMessage {
  id: string;
  created_time: string;
  from?: { id?: string; name?: string };
  message?: string;
}

@Injectable()
export class GraphClient {
  private readonly logger = new Logger(GraphClient.name);

  private url(path: string, query: Query = {}): string {
    const { graphVersion } = loadFacebookConfig();
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, v);
    const q = qs.toString();
    return `https://graph.facebook.com/${graphVersion}/${path.replace(/^\//, '')}${q ? `?${q}` : ''}`;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, opts: { token?: string; query?: Query; body?: unknown } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(this.url(path, opts.query), {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      this.logger.warn(`Graph ${method} ${path}: không kết nối được (${(err as Error).name})`);
      throw new GraphApiError(0, null, null, 'Không kết nối được tới Facebook');
    }
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number; error_subcode?: number } } & T;
    if (!res.ok || json.error) {
      const e = json.error ?? {};
      this.logger.warn(`Graph ${method} ${path}: HTTP ${res.status} code=${e.code ?? '-'} subcode=${e.error_subcode ?? '-'}`);
      throw new GraphApiError(res.status, e.code ?? null, e.error_subcode ?? null, e.message ?? `Facebook trả lỗi HTTP ${res.status}`);
    }
    return json;
  }

  /** code (từ hộp thoại đăng nhập) → user token ngắn hạn. */
  async exchangeCode(code: string, redirectUri: string): Promise<string> {
    const c = loadFacebookConfig();
    const r = await this.call<{ access_token: string }>('GET', 'oauth/access_token', {
      query: { client_id: c.appId, client_secret: c.appSecret, redirect_uri: redirectUri, code },
    });
    return r.access_token;
  }

  /** user token ngắn hạn → dài hạn (~60 ngày) — để lấy page token KHÔNG hết hạn. */
  async toLongLived(userToken: string): Promise<string> {
    const c = loadFacebookConfig();
    const r = await this.call<{ access_token: string }>('GET', 'oauth/access_token', {
      query: { grant_type: 'fb_exchange_token', client_id: c.appId, client_secret: c.appSecret, fb_exchange_token: userToken },
    });
    return r.access_token;
  }

  /** Các Page user quản trị kèm page token (từ user token dài hạn ⇒ page token không hết hạn). */
  async listPages(userToken: string): Promise<GraphPage[]> {
    const r = await this.call<{ data?: GraphPage[] }>('GET', 'me/accounts', { token: userToken, query: { fields: 'id,name,access_token,tasks,picture{url}', limit: '100' } });
    return r.data ?? [];
  }

  /** Quyền người dùng đã THẬT SỰ cấp trong lần đăng nhập này (status `granted`). */
  async grantedPermissions(userToken: string): Promise<string[]> {
    const r = await this.call<{ data?: Array<{ permission: string; status: string }> }>('GET', 'me/permissions', { token: userToken });
    return (r.data ?? []).filter((x) => x.status === 'granted').map((x) => x.permission);
  }

  /** Đăng ký Page nhận webhook (messages + leadgen). Cần `pages_manage_metadata`. */
  async subscribePage(pageId: string, pageToken: string, fields: readonly string[]): Promise<void> {
    await this.call('POST', `${pageId}/subscribed_apps`, { token: pageToken, query: { subscribed_fields: fields.join(',') } });
  }

  async unsubscribePage(pageId: string, pageToken: string): Promise<void> {
    await this.call('POST', `${pageId}/subscribed_apps`, { token: pageToken, query: { subscribed_fields: '' } });
  }

  /** Kiểm hạn/hiệu lực token bằng app token `app_id|app_secret`. */
  async debugToken(inputToken: string): Promise<TokenDebug> {
    const c = loadFacebookConfig();
    const r = await this.call<{ data: TokenDebug }>('GET', 'debug_token', { token: `${c.appId}|${c.appSecret}`, query: { input_token: inputToken } });
    return r.data;
  }

  /** Chi tiết lead theo `leadgen_id` (dùng page token). */
  getLead(leadgenId: string, pageToken: string): Promise<LeadData> {
    return this.call<LeadData>('GET', leadgenId, { token: pageToken, query: { fields: 'id,created_time,form_id,ad_id,field_data' } });
  }

  /** Gửi tin văn bản — `messaging_type: RESPONSE` (trong cửa sổ 24h). */
  async sendText(pageToken: string, psid: string, text: string): Promise<{ message_id: string }> {
    return this.call<{ message_id: string }>('POST', 'me/messages', {
      token: pageToken,
      body: { recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text } },
    });
  }

  /** Gửi tin kèm nút trả lời nhanh (quick replies: tối đa 13 nút, tiêu đề ≤20 ký tự) — `payload` quay về trong `message.quick_reply`. */
  async sendQuickReplies(pageToken: string, psid: string, text: string, buttons: Array<{ title: string; payload: string }>): Promise<{ message_id: string }> {
    const quick_replies = buttons.map((b) => ({ content_type: 'text', title: b.title.slice(0, 20), payload: b.payload.slice(0, 1000) }));
    return this.call<{ message_id: string }>('POST', 'me/messages', {
      token: pageToken,
      body: { recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text, quick_replies } },
    });
  }

  /**
   * Bật nút "Bắt đầu" của Page nếu chưa có (không đè cấu hình sẵn). Khách lần đầu mở link m.me?ref=… chỉ mang `ref` về webhook
   * khi bấm nút này (postback kèm referral). Trả true nếu vừa bật.
   */
  async ensureGetStarted(pageToken: string): Promise<boolean> {
    const cur = await this.call<{ data?: Array<{ get_started?: unknown }> }>('GET', 'me/messenger_profile', { token: pageToken, query: { fields: 'get_started' } });
    if (cur.data?.some((d) => d.get_started)) return false;
    await this.call('POST', 'me/messenger_profile', { token: pageToken, body: { get_started: { payload: 'GET_STARTED' } } });
    return true;
  }

  /** Trả lời công khai một bình luận. Cần `pages_manage_engagement`. */
  async replyToComment(pageToken: string, commentId: string, text: string): Promise<{ id: string }> {
    return this.call<{ id: string }>('POST', `${commentId}/comments`, { token: pageToken, body: { message: text } });
  }

  /**
   * Private Reply: nhắn riêng người đã bình luận (1 tin/bình luận, trong 7 ngày). Cần `pages_messaging`.
   * Docs: https://developers.facebook.com/docs/messenger-platform/discovery/private-replies
   */
  async privateReply(pageToken: string, pageId: string, commentId: string, text: string): Promise<{ message_id: string; recipient_id?: string }> {
    return this.call<{ message_id: string; recipient_id?: string }>('POST', `${pageId}/messages`, {
      token: pageToken,
      body: { recipient: { comment_id: commentId }, message: { text } },
    });
  }

  /** Ẩn bình luận (người khác không thấy, người viết vẫn thấy). Cần `pages_manage_engagement`. */
  async hideComment(pageToken: string, commentId: string): Promise<void> {
    await this.call('POST', commentId, { token: pageToken, body: { is_hidden: true } });
  }

  /** Tên hiển thị của khách (best-effort — cần `pages_user_profile`/đã nhắn tin). */
  async getUserName(psid: string, pageToken: string): Promise<string | null> {
    try {
      const r = await this.call<{ name?: string; first_name?: string; last_name?: string }>('GET', psid, { token: pageToken, query: { fields: 'name,first_name,last_name' } });
      return (r.name ?? `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim()) || null;
    } catch {
      return null;
    }
  }

  /** Tin gần nhất của hội thoại Page ↔ khách (mới → cũ), đọc thẳng từ Facebook — bù tin webhook không về. */
  async getRecentMessages(pageId: string, psid: string, pageToken: string, limit = 20): Promise<GraphConversationMessage[]> {
    const r = await this.call<{ data?: Array<{ messages?: { data?: GraphConversationMessage[] } }> }>('GET', `${pageId}/conversations`, {
      token: pageToken,
      query: { platform: 'messenger', user_id: psid, fields: `messages.limit(${limit}){id,created_time,from,message}` },
    });
    return r.data?.[0]?.messages?.data ?? [];
  }

  /**
   * Tên khách lấy từ hội thoại của Page (`participants`) — đường dự phòng khi `/{PSID}` bị chặn:
   * người nhắn không có vai trò trong app mà app chưa được duyệt Business Asset User Profile Access.
   */
  async getConversationName(pageId: string, psid: string, pageToken: string): Promise<string | null> {
    try {
      const r = await this.call<{ data?: Array<{ participants?: { data?: Array<{ id?: string; name?: string }> } }> }>('GET', `${pageId}/conversations`, {
        token: pageToken,
        query: { platform: 'messenger', user_id: psid, fields: 'participants' },
      });
      for (const c of r.data ?? []) {
        const name = c.participants?.data?.find((x) => x.id === psid)?.name?.trim();
        if (name) return name;
      }
      return null;
    } catch {
      return null;
    }
  }
}
