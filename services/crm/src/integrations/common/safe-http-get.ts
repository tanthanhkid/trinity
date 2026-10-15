import * as http from 'node:http';
import * as https from 'node:https';
import { assertSafeUrl, createSafeLookup, type Resolver } from '../webhooks/ssrf-guard';

export const SAFE_GET_TIMEOUT_MS = 5_000;
export const SAFE_GET_MAX_BYTES = 64 * 1024;

export interface SafeGetResult {
  statusCode: number;
  /** `max-age` (giây) trong Cache-Control nếu có. */
  maxAgeSec: number | null;
  json: unknown;
}

export class SafeGetError extends Error {}

function parseMaxAge(v: string | string[] | undefined): number | null {
  const s = Array.isArray(v) ? v.join(',') : v;
  if (!s || /no-store|no-cache/i.test(s)) return 0;
  const m = /max-age=(\d{1,9})/i.exec(s);
  return m ? Number(m[1]) : null;
}

interface RawGet {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/**
 * Lõi GET an toàn dùng CHUNG bộ chặn SSRF của webhook ra (`ssrf-guard`: chỉ https, cổng 443/8443, mọi IP phân giải phải
 * công cộng, `lookup` tự kiểm chống DNS rebinding), KHÔNG theo redirect, có timeout và trần thân. `acceptType` kiểm
 * content-type trước khi đọc thân. Lỗi chỉ trả mã chung — không lộ nội dung/IP nội bộ.
 */
async function safeGetRaw(
  rawUrl: string,
  o: { env: NodeJS.ProcessEnv; resolver?: Resolver; timeoutMs: number; maxBytes: number; accept: string; userAgent: string; acceptType: (ctype: string) => string | null },
): Promise<RawGet> {
  let target;
  try {
    target = await assertSafeUrl(rawUrl, { env: o.env, resolver: o.resolver });
  } catch {
    throw new SafeGetError('blocked_target');
  }
  const { url, hostname } = target;
  const secure = url.protocol === 'https:';
  const lib = secure ? https : http;

  return new Promise<RawGet>((resolve, reject) => {
    let settled = false;
    const fail = (code: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(new SafeGetError(code));
    };
    const request = lib.request(
      {
        method: 'GET',
        hostname,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers: { Accept: o.accept, 'User-Agent': o.userAgent, 'Accept-Encoding': 'identity' },
        agent: false,
        lookup: createSafeLookup(o.env, o.resolver) as never,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status !== 200) {
          res.destroy();
          return fail(status >= 300 && status < 400 ? 'redirect_not_followed' : `http_${status}`);
        }
        const bad = o.acceptType(String(res.headers['content-type'] ?? ''));
        if (bad) {
          res.destroy();
          return fail(bad);
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > o.maxBytes) {
          res.destroy();
          return fail('too_large');
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > o.maxBytes) {
            res.destroy();
            fail('too_large');
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          resolve({ statusCode: status, headers: res.headers, body: Buffer.concat(chunks) });
        });
        res.on('error', () => fail('network_error'));
      },
    );
    const deadline = setTimeout(() => {
      fail('timeout');
      request.destroy();
    }, o.timeoutMs);
    request.on('error', () => fail('network_error'));
    request.end();
  });
}

/**
 * GET JSON an toàn cho việc tải Client ID Metadata Document (CIMD): timeout 5s, thân ≤ 64 KiB, phải là JSON (xem `safeGetRaw`).
 */
export async function safeGetJson(
  rawUrl: string,
  opts: { env?: NodeJS.ProcessEnv; resolver?: Resolver; timeoutMs?: number; maxBytes?: number } = {},
): Promise<SafeGetResult> {
  const r = await safeGetRaw(rawUrl, {
    env: opts.env ?? process.env,
    resolver: opts.resolver,
    timeoutMs: opts.timeoutMs ?? SAFE_GET_TIMEOUT_MS,
    maxBytes: opts.maxBytes ?? SAFE_GET_MAX_BYTES,
    accept: 'application/json',
    userAgent: 'Trinity-CRM-OAuth/1',
    acceptType: (ctype) => (/^application\/([a-z0-9.+-]+\+)?json\b/i.test(ctype) ? null : 'not_json'),
  });
  let json: unknown;
  try {
    json = JSON.parse(r.body.toString('utf8')) as unknown;
  } catch {
    throw new SafeGetError('invalid_json');
  }
  return { statusCode: r.statusCode, maxAgeSec: parseMaxAge(r.headers['cache-control']), json };
}

/** Tải ảnh/video từ URL công khai (AI đưa link tệp nó vừa tạo): chỉ `image/*` hoặc `video/*`, timeout 30s, trần do người gọi đặt. */
export async function safeGetMedia(
  rawUrl: string,
  opts: { maxBytes: number; env?: NodeJS.ProcessEnv; resolver?: Resolver; timeoutMs?: number },
): Promise<{ contentType: string; body: Buffer }> {
  const r = await safeGetRaw(rawUrl, {
    env: opts.env ?? process.env,
    resolver: opts.resolver,
    timeoutMs: opts.timeoutMs ?? 30_000,
    maxBytes: opts.maxBytes,
    accept: 'image/*,video/*',
    userAgent: 'Trinity-CRM-Media/1',
    acceptType: (ctype) => (/^(image|video)\/[a-z0-9.+-]+/i.test(ctype) ? null : 'not_media'),
  });
  return { contentType: String(r.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase(), body: r.body };
}
