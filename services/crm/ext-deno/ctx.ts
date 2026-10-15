// SDK mini mà chương trình con nhận. Mã TIN CẬY — chạy trong tiến trình Deno nhưng nằm ngoài mã khách.
// Chương trình con chỉ chạm hệ thống qua `ctx.records` (cổng nội bộ + token PHẠM VI: chỉ bảng được cấp), không chạm DB.

export interface Gateway {
  url: string;
  token: string;
}

export interface RecordsApi {
  /** Tạo bản ghi mới ở bảng `table` (tối đa 500 dòng/lần). Khi chạy thử (`ctx.dryRun`) KHÔNG ghi thật, chỉ đếm. */
  create(table: string, rows: Record<string, unknown>[]): Promise<{ created: number; dry_run?: boolean }>;
  /** Đọc bản ghi (mới nhất trước), tối đa 50/lần; `cursor` là `next_cursor` của lần trước. */
  list(table: string, q?: { limit?: number; cursor?: string }): Promise<{ items: unknown[]; next_cursor: string | null }>;
}

export interface ExtCtx {
  params: unknown;
  dryRun: boolean;
  records: RecordsApi;
  log(...args: unknown[]): void;
}

async function call(gw: Gateway | undefined, method: string, path: string, body?: unknown): Promise<unknown> {
  if (!gw) throw new Error("chương trình con không được cấp quyền dữ liệu (manifest.tables rỗng)");
  const res = await fetch(`${gw.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${gw.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`cổng nội bộ ${res.status}: ${await res.text()}`);
  return res.json();
}

export function makeCtx(params: unknown, gw?: Gateway, dryRun = false): ExtCtx {
  return {
    params,
    dryRun,
    log: (...a) => console.log(...a),
    records: {
      create: (table, rows) => call(gw, "POST", `/records/${encodeURIComponent(table)}`, { rows }) as Promise<{ created: number; dry_run?: boolean }>,
      list: (table, q = {}) => {
        const qs = new URLSearchParams();
        if (q.limit) qs.set("limit", String(q.limit));
        if (q.cursor) qs.set("cursor", q.cursor);
        return call(gw, "GET", `/records/${encodeURIComponent(table)}?${qs}`) as Promise<{ items: unknown[]; next_cursor: string | null }>;
      },
    },
  };
}
