import * as http from 'node:http';
import * as https from 'node:https';
import { assertSafeUrl, createSafeLookup, SsrfBlockedError, type Resolver } from './ssrf-guard';

export const DELIVERY_TIMEOUT_MS = 10_000;

export interface HttpPostRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs?: number;
}

export interface HttpPostResult {
  ok: boolean;
  statusCode: number | null;
  /** Mã lỗi ngắn, an toàn để lưu/hiển thị (KHÔNG chứa URL/IP/nội dung phản hồi). */
  error: string | null;
  durationMs: number;
}

const ERROR_CODES: Record<string, string> = {
  ENOTFOUND: 'dns_error',
  EAI_AGAIN: 'dns_error',
  ECONNREFUSED: 'connection_refused',
  ECONNRESET: 'connection_reset',
  EPIPE: 'connection_reset',
  ETIMEDOUT: 'timeout',
  EHOSTUNREACH: 'unreachable',
  ENETUNREACH: 'unreachable',
};

export function classifyNetworkError(err: unknown): string {
  if (err instanceof SsrfBlockedError) return 'blocked_target';
  const code = (err as NodeJS.ErrnoException | undefined)?.code ?? '';
  if (ERROR_CODES[code]) return ERROR_CODES[code];
  if (/CERT|TLS|SSL|ALTNAME|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) return 'tls_error';
  if ((err as Error | undefined)?.message === 'timeout') return 'timeout';
  return 'network_error';
}

/**
 * POST JSON, KHÔNG theo redirect, timeout 10s tổng. Dùng `node:http(s)` có sẵn (không thêm dependency) vì cần
 * `lookup` tự kiểm để chống DNS rebinding — `fetch` toàn cục không cho gắn `lookup`.
 * `hostname` được giữ nguyên ⇒ SNI (Node tự đặt từ hostname) + `Host` đúng tên miền gốc; chỉ phần kết nối đi tới IP đã kiểm.
 */
export async function postJson(
  req: HttpPostRequest,
  opts: { env?: NodeJS.ProcessEnv; resolver?: Resolver } = {},
): Promise<HttpPostResult> {
  const env = opts.env ?? process.env;
  const started = Date.now();
  const done = (partial: Omit<HttpPostResult, 'durationMs'>): HttpPostResult => ({ ...partial, durationMs: Date.now() - started });
  const timeoutMs = req.timeoutMs ?? DELIVERY_TIMEOUT_MS;
  let target;
  try {
    // Phân giải DNS lần 1 cũng nằm TRONG hạn 10s (resolver treo không được giữ việc quá lease).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), timeoutMs); });
    try {
      target = await Promise.race([assertSafeUrl(req.url, { env, resolver: opts.resolver }), limit]);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return done({ ok: false, statusCode: null, error: classifyNetworkError(err) });
  }
  const { url, hostname } = target;
  const secure = url.protocol === 'https:';
  const lib = secure ? https : http;

  return new Promise<HttpPostResult>((resolve) => {
    let settled = false;
    const finish = (r: Omit<HttpPostResult, 'durationMs'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(done(r));
    };
    const request = lib.request(
      {
        method: 'POST',
        hostname,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers: { ...req.headers, 'Content-Length': Buffer.byteLength(req.body).toString() },
        agent: false,
        lookup: createSafeLookup(env, opts.resolver) as never,
      },
      (res) => {
        // Chỉ cần mã trạng thái: kết luận NGAY khi có header (nội dung phản hồi không bao giờ được đọc/lưu).
        const status = res.statusCode ?? null;
        const ok = status !== null && status >= 200 && status < 300;
        const redirect = status !== null && status >= 300 && status < 400;
        finish({ ok, statusCode: status, error: ok ? null : redirect ? 'redirect_not_followed' : `http_${status ?? 'unknown'}` });
        res.destroy();
        request.destroy();
      },
    );
    const deadline = setTimeout(() => {
      finish({ ok: false, statusCode: null, error: 'timeout' });
      request.destroy(new Error('timeout'));
    }, timeoutMs);
    request.on('error', (err) => finish({ ok: false, statusCode: null, error: classifyNetworkError(err) }));
    request.end(req.body);
  });
}
