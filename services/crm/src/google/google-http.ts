import { Injectable } from '@nestjs/common';

export interface GoogleHttpRequest {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  headers?: Record<string, string>;
  /** JSON body (object) hoặc form (URLSearchParams). */
  json?: unknown;
  form?: Record<string, string>;
}
export interface GoogleHttpResponse {
  status: number;
  json: unknown;
}

const TIMEOUT_MS = 20_000;

/** Lớp HTTP mỏng tới Google — tách riêng để test thay bằng mock (KHÔNG gọi Google thật trong test). */
@Injectable()
export class GoogleHttp {
  async request(req: GoogleHttpRequest): Promise<GoogleHttpResponse> {
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    let body: string | undefined;
    if (req.form) {
      body = new URLSearchParams(req.form).toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    } else if (req.json !== undefined) {
      body = JSON.stringify(req.json);
      headers['content-type'] = 'application/json';
    }
    const res = await fetch(req.url, { method: req.method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    return { status: res.status, json };
  }
}

/** Thông báo lỗi Google đã rút gọn, KHÔNG chứa token. */
export function googleErrorMessage(json: unknown, status: number): string {
  const o = (json && typeof json === 'object' ? json : {}) as { error?: unknown; error_description?: unknown };
  const err = o.error;
  const msg =
    typeof err === 'string' ? err : err && typeof err === 'object' ? String((err as { message?: unknown }).message ?? '') : '';
  const desc = typeof o.error_description === 'string' ? ` — ${o.error_description}` : '';
  return `Google ${status}: ${(msg + desc).slice(0, 200) || 'lỗi không rõ'}`;
}
