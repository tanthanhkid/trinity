#!/usr/bin/env node
/**
 * Bộ tạo tải cố định cho baseline (R003). Chỉ gọi API đọc + đăng nhập; không ghi dữ liệu.
 *
 *   BASE=http://127.0.0.1:4210 EMAIL=... PASSWORD=... node tests/load/run.mjs [nhãn]
 *
 * Env: BASE (gốc, không có /api/v1), EMAIL, PASSWORD, DURATION_S (mặc định 15), CONCURRENCY (mặc định "10,50"),
 *      HEALTH_PATH (mặc định /api/v1/health).
 * In một dòng JSON mỗi kịch bản: {label, scenario, concurrency, requests, errors, rps, p50_ms, p95_ms, p99_ms}.
 */
const BASE = (process.env.BASE ?? 'http://127.0.0.1:4210').replace(/\/+$/, '');
const EMAIL = process.env.EMAIL ?? '';
const PASSWORD = process.env.PASSWORD ?? '';
const DURATION = Number(process.env.DURATION_S ?? 15) * 1000;
const LEVELS = (process.env.CONCURRENCY ?? '10,50').split(',').map(Number);
const HEALTH = process.env.HEALTH_PATH ?? '/api/v1/health';
const label = process.argv[2] ?? 'run';

async function login() {
  const r = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const j = await r.json().catch(() => ({}));
  const t = j.access_token ?? j.accessToken ?? j.data?.access_token ?? j.data?.accessToken;
  if (!t) throw new Error(`Đăng nhập lỗi (${r.status}): ${JSON.stringify(j).slice(0, 120)}`);
  return t;
}

const pct = (a, p) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] ?? 0;

async function drive(name, conc, fn) {
  const lat = [];
  let errors = 0;
  const end = Date.now() + DURATION;
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (Date.now() < end) {
        const t0 = performance.now();
        try {
          const ok = await fn();
          if (!ok) errors++;
        } catch {
          errors++;
        }
        lat.push(performance.now() - t0);
      }
    }),
  );
  lat.sort((a, b) => a - b);
  const r = (x) => Math.round(x * 10) / 10;
  console.log(JSON.stringify({ label, scenario: name, concurrency: conc, requests: lat.length, errors, rps: r(lat.length / (DURATION / 1000)), p50_ms: r(pct(lat, 50)), p95_ms: r(pct(lat, 95)), p99_ms: r(pct(lat, 99)) }));
}

const token = await login();
const auth = { authorization: `Bearer ${token}` };
const get = async (path, headers) => {
  const r = await fetch(BASE + path, { headers });
  await r.arrayBuffer();
  return r.ok;
};

for (const c of LEVELS) {
  await drive('health', c, () => get(HEALTH));
  await drive('contacts_20', c, () => get('/api/v1/contacts?limit=20', auth));
}
// Đăng nhập (giới hạn tốc độ có thể trả 429 ⇒ tính vào errors): một mức thấp
await drive('login', 2, async () => (await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) })).ok);
