#!/usr/bin/env node
/**
 * Ca đo X05 trên bản Rust (đăng nhập khi Graph treo, tệp xuất lớn nhất, tải lên 95 MB theo phần).
 * Chỉ ghi dữ liệu thử vào DB RIÊNG; không chạy trên DB thật. In mỗi ca một dòng JSON.
 *
 *   BASE=http://127.0.0.1:3000 EMAIL=... PASSWORD=... node tests/load/perf.mjs <ca...> [--label nhãn]
 *
 * Ca: login-graph-treo | export | upload-95mb | all
 * Env: HANG_PATH (mặc định /api/v1/facebook/pages — route gọi Graph), HANG_N (10), LOGIN_N (20),
 *      EXPORT_PATH (mặc định /api/v1/contacts/export), EXPORT_TIMEOUT_S (300), UPLOAD_MB (95).
 * Đích: đăng nhập < 1 s (p95 trên máy 2 GB), xuất < 100 s, tải lên 95 MB chạy xong không đứt.
 * Yêu cầu: Node >= 20; Graph giả đang chạy (graph-stub.mjs) và máy chủ đặt FACEBOOK_GRAPH_BASE_URL trỏ vào đó.
 */
const BASE = (process.env.BASE ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const EMAIL = process.env.EMAIL ?? '';
const PASSWORD = process.env.PASSWORD ?? '';
const args = process.argv.slice(2);
const li = args.indexOf('--label');
const label = li >= 0 ? args.splice(li, 2)[1] : 'run';
const cases = args.length && !args.includes('all') ? args : ['login-graph-treo', 'export', 'upload-95mb'];
const num = (k, d) => Number(process.env[k] ?? d);
const out = (o) => console.log(JSON.stringify({ label, ...o }));
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] ?? 0;
const r1 = (x) => Math.round(x * 10) / 10;

async function login() {
  const t0 = performance.now();
  const r = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const j = await r.json().catch(() => ({}));
  const token = j.access_token ?? j.accessToken ?? j.data?.access_token;
  return { ms: performance.now() - t0, status: r.status, token };
}

async function loginGraphTreo() {
  const base = await login();
  if (!base.token) throw new Error(`đăng nhập lỗi ${base.status}`);
  const auth = { authorization: `Bearer ${base.token}` };
  const hangN = num('HANG_N', 10);
  const path = process.env.HANG_PATH ?? '/api/v1/facebook/pages';
  const ac = new AbortController();
  // 10 request treo ở Graph (stub không trả lời); giữ cho tới khi đo xong
  const hung = Array.from({ length: hangN }, () =>
    fetch(BASE + path, { headers: auth, signal: ac.signal }).then((r) => r.status, () => 'aborted'),
  );
  await new Promise((r) => setTimeout(r, 1500)); // để các request vào tới handler
  const n = num('LOGIN_N', 20);
  const ms = [];
  let errors = 0;
  for (let i = 0; i < n; i++) {
    const x = await login();
    if (x.status >= 400 || !x.token) errors++;
    ms.push(x.ms);
  }
  ac.abort();
  await Promise.allSettled(hung);
  ms.sort((a, b) => a - b);
  out({
    case: 'login-graph-treo', hung: hangN, logins: n, errors,
    p50_ms: r1(pct(ms, 50)), p95_ms: r1(pct(ms, 95)), max_ms: r1(ms[ms.length - 1]),
    login_khong_treo_ms: r1(base.ms), dat_duoi_1s: pct(ms, 95) < 1000 && errors === 0,
  });
}

async function exportBig() {
  const { token } = await login();
  if (!token) throw new Error('đăng nhập lỗi');
  const path = process.env.EXPORT_PATH ?? '/api/v1/contacts/export';
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), num('EXPORT_TIMEOUT_S', 300) * 1000);
  const t0 = performance.now();
  let status = 0, bytes = 0;
  try {
    const r = await fetch(BASE + path, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
    status = r.status;
    for await (const c of r.body) bytes += c.length;
  } catch (e) {
    status = `lỗi: ${e.name}`;
  }
  clearTimeout(to);
  const s = (performance.now() - t0) / 1000;
  out({ case: 'export', path, status, bytes, seconds: r1(s), dat_duoi_100s: status === 200 && s < 100 });
}

async function upload95() {
  const { token } = await login();
  if (!token) throw new Error('đăng nhập lỗi');
  const mb = num('UPLOAD_MB', 95);
  const size = mb * 1024 * 1024;
  const h = { authorization: `Bearer ${token}` };
  const t0 = performance.now();
  const post = (p, body) =>
    fetch(BASE + p, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const init = await post('/api/v1/social/media/uploads', { fileName: 'x05-test.mp4', size });
  const ij = await init.json().catch(() => ({}));
  const d = ij.data ?? ij;
  const id = d.uploadId ?? d.upload_id;
  if (!id) return out({ case: 'upload-95mb', ok: false, step: 'init', status: init.status, body: JSON.stringify(ij).slice(0, 160) });
  const partSize = d.partSize ?? d.part_size;
  const total = d.totalParts ?? d.total_parts;
  let peak = 0;
  for (let i = 0; i < total; i++) {
    const len = i === total - 1 ? size - partSize * (total - 1) : partSize;
    const r = await fetch(`${BASE}/api/v1/social/media/uploads/${id}/parts/${i}`, {
      method: 'PUT', headers: { ...h, 'content-type': 'application/octet-stream' }, body: Buffer.alloc(len, 1),
    });
    if (!r.ok) return out({ case: 'upload-95mb', ok: false, step: `part ${i}`, status: r.status });
    peak = Math.max(peak, len);
  }
  const done = await post(`/api/v1/social/media/uploads/${id}/complete`);
  out({ case: 'upload-95mb', mb, parts: total, ok: done.status < 300, status: done.status, seconds: r1((performance.now() - t0) / 1000) });
}

const table = { 'login-graph-treo': loginGraphTreo, export: exportBig, 'upload-95mb': upload95 };
for (const c of cases) {
  if (!table[c]) { console.error(`ca không có: ${c}`); process.exit(2); }
  try { await table[c](); } catch (e) { out({ case: c, error: String(e.message ?? e) }); }
}
