/**
 * Bộ dùng chung cho e2e MCP: HTTP, đăng nhập JWT, OAuth (DCR + PKCE S256) lấy token, MCP client thật (@modelcontextprotocol/sdk,
 * streamable HTTP), duyệt nháp bằng API web (chỉ khi bật chế độ "Yêu cầu duyệt thay đổi do AI"; mặc định MCP ghi thẳng). run.mjs giữ bản riêng; các kịch bản mới dùng file này.
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

export const REDIRECT = 'http://localhost:8976/callback';
export const b64u = (b) => Buffer.from(b).toString('base64url');
export const assert = (c, m) => { if (!c) throw new Error(m); };

export function loadConfig(file) {
  const cfg = Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  cfg.BASE = (process.env.MCP_BASE || cfg.MCP_BASE || 'http://localhost:4000').replace(/\/+$/, '');
  return cfg;
}

export function harness(BASE) {
  const results = [];
  let failed = 0;
  async function step(name, fn) {
    try {
      const detail = await fn();
      results.push({ name, ok: true });
      console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
    } catch (e) {
      failed += 1; results.push({ name, ok: false });
      console.log(`FAIL  ${name} — ${String(e?.message ?? e).slice(0, 500)}`);
    }
  }
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
    assert(r.status === 200, `login ${email.split('@')[0]} => ${r.status}`);
    const t = r.json?.access_token ?? r.json?.data?.access_token ?? r.json?.accessToken;
    assert(t, 'login không trả access_token');
    return t;
  }
  async function oauthToken(jwt, clientName, scopes = ['crm.read', 'crm.write']) {
    const reg = await http('POST', '/api/v1/oauth/register', { body: { client_name: clientName, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], scope: scopes.join(' ') } });
    assert(reg.status === 201, `DCR => ${reg.status}`);
    const clientId = reg.json.client_id;
    const verifier = b64u(randomBytes(32));
    const params = { response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: scopes.join(' '), state: b64u(randomBytes(8)), code_challenge: b64u(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', resource: `${BASE}/api/v1/mcp` };
    const ctx = await http('POST', '/api/v1/oauth/authorize/context', { token: jwt, body: { params } });
    assert(ctx.status === 200 && ctx.json?.ok, `authorize/context => ${ctx.status} ${ctx.text.slice(0, 200)}`);
    const dec = await http('POST', '/api/v1/oauth/authorize/decision', { token: jwt, body: { params, approve: true, consent_token: ctx.json.consent_token, granted_scopes: scopes } });
    assert(dec.status === 200 && dec.json?.redirect_to, `authorize/decision => ${dec.status}`);
    const code = new URL(dec.json.redirect_to).searchParams.get('code');
    const tok = await http('POST', '/api/v1/oauth/token', { form: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${BASE}/api/v1/mcp` } });
    assert(tok.status === 200 && tok.json?.access_token, `token => ${tok.status}`);
    return { accessToken: tok.json.access_token, scope: tok.json.scope };
  }
  async function connect(accessToken) {
    const client = new Client({ name: 'trinity-e2e', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/api/v1/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
    client.rawToken = accessToken;
    return client;
  }
  const call = async (c, name, args) => {
    const r = await c.callTool({ name, arguments: args });
    return { isError: !!r.isError, text: r.content?.[0]?.text ?? '', data: r.structuredContent?.data };
  };
  async function approveDraft(jwt, id) {
    const r = await http('POST', `/api/v1/integrations/ai-actions/${id}/approve`, { token: jwt });
    assert(r.status === 200, `approve #${id} => ${r.status} ${r.text.slice(0, 300)}`);
    return r.json;
  }
  /** Một người dùng: đăng nhập + OAuth + MCP client. */
  async function actor(label, email, password) {
    const jwt = await login(email, password);
    const t = await oauthToken(jwt, `trinity-e2e-${label}`);
    return { label, jwt, mcp: await connect(t.accessToken), email };
  }
  const summary = () => { console.log(`\n# Kết quả: ${results.length - failed} PASS / ${failed} FAIL (tổng ${results.length})`); return failed; };
  return { step, http, login, oauthToken, connect, call, approveDraft, actor, summary };
}
