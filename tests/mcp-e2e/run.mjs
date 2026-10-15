#!/usr/bin/env node
/**
 * E2E MCP bằng MCP client THẬT (@modelcontextprotocol/sdk, transport streamable HTTP) + OAuth 2.1 (DCR + PKCE S256)
 * như ChatGPT dùng — chỉ khác: bước "đăng nhập + bấm Cho phép" làm bằng API (JWT của user thử) thay vì trình duyệt.
 *
 *   node tests/mcp-e2e/run.mjs [đường-dẫn-credentials]
 * Credentials (KEY=VALUE): MCP_BASE, MCP_ADMIN_EMAIL/PASSWORD, MCP_LOW_EMAIL/PASSWORD (tạo bằng setup-users.mjs).
 * MCP_BASE mặc định http://localhost:4000 (instance tự dựng). KHÔNG chạy trên hệ thống có dữ liệu thật.
 */
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const req = createRequire(resolve(root, 'services/crm/package.json'));
const { Client } = req('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = req('@modelcontextprotocol/sdk/client/streamableHttp.js');

const credFile = process.argv[2] || process.env.MCP_CREDENTIALS || (console.error('Cần đường dẫn file credentials (đối số 1 hoặc biến MCP_CREDENTIALS)'), process.exit(2));
const cfg = Object.fromEntries(readFileSync(credFile, 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = (process.env.MCP_BASE || cfg.MCP_BASE || 'http://localhost:4000').replace(/\/+$/, '');
const REDIRECT = 'http://localhost:8976/callback';
// Chỉ chữ (không chuỗi số liền): `search` từ chối ≥ 4 chữ số để chống dò SĐT.
const TAG = `[MCP e2e ${Array.from(randomBytes(6), (b) => String.fromCharCode(97 + (b % 26))).join('')}]`;

const results = [];
let failed = 0;
async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (e) {
    failed += 1;
    results.push({ name, ok: false });
    console.log(`FAIL  ${name} — ${String(e?.message ?? e).slice(0, 400)}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const b64u = (b) => Buffer.from(b).toString('base64url');

async function http(method, path, { body, token, form } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload, redirect: 'manual' });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text, headers: res.headers };
}

async function login(email, password) {
  const r = await http('POST', '/api/v1/auth/login', { body: { email, password } });
  assert(r.status === 200, `login ${email} => ${r.status}`);
  const t = r.json?.access_token ?? r.json?.data?.access_token ?? r.json?.accessToken;
  assert(t, 'login không trả access_token');
  return t;
}

/** DCR → authorize (context + decision bằng JWT) → đổi code (PKCE S256) → access token OAuth. */
async function oauthToken(jwt, clientName) {
  const reg = await http('POST', '/api/v1/oauth/register', { body: { client_name: clientName, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], scope: 'crm.read crm.write' } });
  assert(reg.status === 201, `DCR => ${reg.status} ${reg.text.slice(0, 200)}`);
  const clientId = reg.json.client_id;
  const verifier = b64u(randomBytes(32));
  const params = {
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: 'crm.read crm.write', state: b64u(randomBytes(8)),
    code_challenge: b64u(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', resource: `${BASE}/api/v1/mcp`,
  };
  const ctx = await http('POST', '/api/v1/oauth/authorize/context', { token: jwt, body: { params } });
  assert(ctx.status === 200 && ctx.json?.ok, `authorize/context => ${ctx.status} ${ctx.text.slice(0, 300)}`);
  const dec = await http('POST', '/api/v1/oauth/authorize/decision', { token: jwt, body: { params, approve: true, consent_token: ctx.json.consent_token, granted_scopes: ['crm.read', 'crm.write'] } });
  assert(dec.status === 200 && dec.json?.redirect_to, `authorize/decision => ${dec.status} ${dec.text.slice(0, 300)}`);
  const code = new URL(dec.json.redirect_to).searchParams.get('code');
  assert(code, 'không có code trong redirect_to');
  const tok = await http('POST', '/api/v1/oauth/token', { form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${BASE}/api/v1/mcp` } });
  assert(tok.status === 200 && tok.json?.access_token, `token => ${tok.status} ${tok.text.slice(0, 200)}`);
  return { accessToken: tok.json.access_token, scope: tok.json.scope };
}

async function connect(accessToken) {
  const client = new Client({ name: 'trinity-e2e', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/api/v1/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  return client;
}

const call = async (c, name, args) => {
  const r = await c.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  return { isError: !!r.isError, text, data: r.structuredContent?.data };
};

async function approveDraft(jwt, id) {
  const r = await http('POST', `/api/v1/integrations/ai-actions/${id}/approve`, { token: jwt });
  assert(r.status === 200, `approve #${id} => ${r.status} ${r.text.slice(0, 300)}`);
  return r.json;
}

const created = []; // [object, id] để dọn cuối

async function main() {
  console.log(`# E2E MCP → ${BASE}  (${new Date().toISOString()})`);

  await step('discovery: protected-resource + authorization-server (DCR, S256)', async () => {
    const pr = await http('GET', '/.well-known/oauth-protected-resource/api/v1/mcp');
    const prFallback = pr.status === 200 ? pr : await http('GET', '/.well-known/oauth-protected-resource');
    assert(prFallback.status === 200 && prFallback.json?.resource === `${BASE}/api/v1/mcp`, `PRM => ${prFallback.status} ${prFallback.text.slice(0, 120)}`);
    const as = await http('GET', '/.well-known/oauth-authorization-server');
    assert(as.status === 200 && as.json?.registration_endpoint && as.json.code_challenge_methods_supported?.includes('S256'), `AS metadata => ${as.status}`);
    return `resource=${prFallback.json.resource}; registration_endpoint có; scopes=${as.json.scopes_supported}`;
  });
  await step('POST /api/v1/mcp không token ⇒ 401 + WWW-Authenticate (resource_metadata)', async () => {
    const r = await http('POST', '/api/v1/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    assert(r.status === 401, `status ${r.status}`);
    assert(/resource_metadata=/.test(r.headers.get('www-authenticate') ?? ''), 'thiếu resource_metadata');
  });

  const adminJwt = await login(cfg.MCP_ADMIN_EMAIL, cfg.MCP_ADMIN_PASSWORD);
  let admin;
  await step('OAuth (DCR + PKCE + consent) cho user admin, scope crm.read crm.write', async () => {
    const t = await oauthToken(adminJwt, 'trinity-e2e-admin');
    assert(/crm\.write/.test(t.scope ?? ''), `scope cấp: ${t.scope}`);
    admin = await connect(t.accessToken);
    admin.rawToken = t.accessToken;
    return `scope=${t.scope}`;
  });
  if (!admin) return;

  let tools;
  await step('tools/list thấy 5 tool mới, không có tool xoá/sửa cấu trúc', async () => {
    tools = (await admin.listTools()).tools;
    const names = tools.map((t) => t.name);
    for (const n of ['describe_schema', 'list_records', 'get_record', 'create_record', 'update_record']) assert(names.includes(n), `thiếu ${n}`);
    assert(!names.some((n) => /delete|remove|drop|structure/i.test(n)), `có tool xoá: ${names}`);
    assert(tools.find((t) => t.name === 'create_record').annotations?.readOnlyHint === false, 'create_record phải readOnlyHint=false');
    return `${names.length} tool: ${names.join(', ')}`;
  });

  let schema; let hs;
  await step('describe_schema: thấy bảng lõi + bảng tuỳ biến (Học sinh) với trường/kiểu/lựa chọn/quyền', async () => {
    const r = await call(admin, 'describe_schema', {});
    assert(!r.isError, r.text);
    schema = r.data.tables;
    hs = schema.find((t) => t.key === 'hoc_sinh');
    assert(hs, `không có hoc_sinh; bảng: ${schema.map((t) => t.key)}`);
    assert(schema.some((t) => t.kind === 'core' && t.key === 'contacts'), 'thiếu bảng lõi contacts');
    assert(hs.permissions.create && hs.permissions.update, 'admin phải có quyền tạo/sửa');
    const tt = hs.fields.find((f) => f.key === 'tinh_trang_hoc');
    assert(tt?.choices?.length > 0, 'select không có lựa chọn');
    return `${schema.length} bảng: ${schema.map((t) => `${t.key}(${t.kind})`).join(', ')}; hoc_sinh ${hs.fields.length} trường`;
  });
  if (!hs) return;
  const choice = hs.fields.find((f) => f.key === 'tinh_trang_hoc').choices[0].value;

  await step('list_records hoc_sinh (phân trang, tổng)', async () => {
    const r = await call(admin, 'list_records', { object: 'hoc_sinh', limit: 5 });
    assert(!r.isError, r.text);
    assert(Array.isArray(r.data.records) && 'total' in r.data, 'sai dạng kết quả');
    return `total=${r.data.total}, trả ${r.data.records.length}`;
  });

  let draftId; let recId;
  const title = `${TAG} Học sinh thử`;
  await step('create_record ⇒ THỰC HIỆN NGAY (executed + record_id), bản ghi có ngay', async () => {
    const r = await call(admin, 'create_record', { object: 'hoc_sinh', values: { ho_ten: title, tuoi: 9, tinh_trang_hoc: choice } });
    assert(!r.isError, r.text);
    assert(r.data.status === 'executed' && r.data.action_id && r.data.result?.record_id, JSON.stringify(r.data));
    draftId = r.data.action_id; recId = r.data.result.record_id; created.push(['hoc_sinh', recId]);
    const l = await call(admin, 'list_records', { object: 'hoc_sinh', search: title });
    assert(!l.isError && l.data.records.length === 1, `bản ghi chưa có ngay sau khi ghi: ${l.text.slice(0, 200)}`);
    return `action_id=${draftId}, record_id=${recId}`;
  });
  await step('create_record sai kiểu (tuoi="chín") ⇒ báo lỗi, không ghi gì', async () => {
    const r = await call(admin, 'create_record', { object: 'hoc_sinh', values: { ho_ten: `${TAG} sai`, tuoi: 'chín' } });
    assert(r.isError && /tuoi/.test(r.text), `kỳ vọng lỗi nêu trường tuoi, nhận: ${r.text.slice(0, 200)}`);
    return r.text.slice(0, 160);
  });
  await step('create_record thiếu trường bắt buộc / lựa chọn không hợp lệ / bảng không tồn tại ⇒ lỗi', async () => {
    const a = await call(admin, 'create_record', { object: 'hoc_sinh', values: { tuoi: 8 } });
    const b = await call(admin, 'create_record', { object: 'hoc_sinh', values: { ho_ten: 'x', tinh_trang_hoc: 'khong_co' } });
    const c = await call(admin, 'create_record', { object: 'khong_ton_tai', values: { a: 1 } });
    assert(a.isError && /ho_ten/.test(a.text), a.text);
    assert(b.isError, 'select sai không báo lỗi');
    assert(c.isError && /describe_schema/.test(c.text), c.text);
  });
  await step('token OAuth không gọi được /ai-actions/:id/approve ⇒ 401 (AI không có đường duyệt)', async () => {
    const r = await http('POST', `/api/v1/integrations/ai-actions/${draftId}/approve`, { token: admin.rawToken });
    assert(r.status === 401, `status ${r.status}`);
  });
  await step('get_record thấy bản ghi vừa ghi; list_records tìm theo tiêu đề thấy; get_action_status = executed', async () => {
    const g = await call(admin, 'get_record', { object: 'hoc_sinh', id: recId });
    assert(!g.isError && g.data.title === title && g.data.data.tuoi === 9, JSON.stringify(g).slice(0, 300));
    const l = await call(admin, 'list_records', { object: 'hoc_sinh', search: TAG });
    assert(!l.isError && l.data.records.some((r) => r.id === recId), 'list không thấy');
    const s = await call(admin, 'get_action_status', { id: draftId });
    assert(s.data.status === 'executed', JSON.stringify(s.data));
  });
  await step('list_records lọc theo select (filter) và sort', async () => {
    const r = await call(admin, 'list_records', { object: 'hoc_sinh', filter: { tinh_trang_hoc: choice }, sort: 'updated_at', dir: 'desc', limit: 50 });
    assert(!r.isError, r.text);
    assert(r.data.records.some((x) => x.id === recId), 'filter không trả bản ghi vừa tạo');
  });
  await step('update_record sai kiểu ⇒ báo lỗi; không đổi gì ⇒ báo lỗi', async () => {
    const a = await call(admin, 'update_record', { object: 'hoc_sinh', id: recId, values: { tuoi: 'abc' } });
    const b = await call(admin, 'update_record', { object: 'hoc_sinh', id: recId, values: { tuoi: 9 } });
    assert(a.isError && /tuoi/.test(a.text), a.text);
    assert(b.isError && /thay đổi/.test(b.text), b.text);
  });
  await step('update_record đúng ⇒ ghi ngay ⇒ get_record thấy giá trị mới', async () => {
    const u = await call(admin, 'update_record', { object: 'hoc_sinh', id: recId, values: { tuoi: 10 } });
    assert(!u.isError && u.data.status === 'executed', u.text);
    const g1 = await call(admin, 'get_record', { object: 'hoc_sinh', id: recId });
    assert(g1.data.data.tuoi === 10, `tuoi=${g1.data.data.tuoi}`);
  });
  await step('get_record id không tồn tại ⇒ lỗi "không tìm thấy"', async () => {
    const r = await call(admin, 'get_record', { object: 'hoc_sinh', id: 2147483000 });
    assert(r.isError && /Không tìm thấy/.test(r.text), r.text);
  });

  // ---- user ít quyền ----
  const lowJwt = await login(cfg.MCP_LOW_EMAIL, cfg.MCP_LOW_PASSWORD);
  let low;
  await step('OAuth cho user ÍT QUYỀN (chỉ ai_connect + custom_records.view own)', async () => {
    low = await connect((await oauthToken(lowJwt, 'trinity-e2e-low')).accessToken);
  });
  if (low) {
    await step('user ít quyền: describe_schema thấy bảng nhưng create/update=false, không có bảng lõi contacts', async () => {
      const r = await call(low, 'describe_schema', {});
      assert(!r.isError, r.text);
      const t = r.data.tables.find((x) => x.key === 'hoc_sinh');
      assert(t && t.permissions.view && !t.permissions.create && !t.permissions.update, JSON.stringify(t?.permissions));
      assert(!r.data.tables.some((x) => x.key === 'contacts'), 'lộ bảng contacts dù không có quyền');
    });
    await step('user ít quyền: create_record / update_record bị TỪ CHỐI (thiếu custom_records.manage)', async () => {
      const a = await call(low, 'create_record', { object: 'hoc_sinh', values: { ho_ten: `${TAG} low` } });
      const b = await call(low, 'update_record', { object: 'hoc_sinh', id: recId, values: { tuoi: 11 } });
      assert(a.isError && /custom_records\.manage/.test(a.text), a.text);
      assert(b.isError && /custom_records\.manage/.test(b.text), b.text);
    });
    await step('user ít quyền: bản ghi của người khác nằm ngoài phạm vi ⇒ get_record không thấy, list không có', async () => {
      const g = await call(low, 'get_record', { object: 'hoc_sinh', id: recId });
      assert(g.isError && /Không tìm thấy/.test(g.text), g.text);
      const l = await call(low, 'list_records', { object: 'hoc_sinh', search: TAG });
      assert(!l.isError && l.data.records.length === 0, `${l.text.slice(0, 120)} thấy ${l.data?.records?.length} bản ghi ngoài phạm vi`);
    });
    await low.close();
  }
  await admin.close();
}

try {
  await main();
} finally {
  // Dọn: xoá mềm bản ghi thử qua API web (không có tool xoá ở MCP — đúng thiết kế).
  try {
    const jwt = await login(cfg.MCP_ADMIN_EMAIL, cfg.MCP_ADMIN_PASSWORD);
    for (const [obj, id] of created) {
      const r = await http('DELETE', `/api/v1/custom-objects/${obj}/records/${id}`, { token: jwt });
      console.log(`cleanup ${obj}#${id}: ${r.status}`);
    }
  } catch (e) { console.log(`cleanup lỗi: ${e.message}`); }
}
console.log(`\n# Kết quả: ${results.length - failed} PASS / ${failed} FAIL (tổng ${results.length})`);
process.exit(failed ? 1 : 0);
