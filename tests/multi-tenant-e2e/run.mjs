#!/usr/bin/env node
/**
 * Multi-tenant end-to-end check against a running Trinity API (MULTI_TENANT=true, local database only).
 *
 *   BASE=http://localhost:4000 node tests/multi-tenant-e2e/run.mjs
 *   (optional) LEGACY_EMAIL / LEGACY_PASSWORD = an existing company-1 account
 *
 * Signs up two companies through the public API, then checks over HTTP that company B cannot list, open, edit,
 * delete or restore company A's contact by guessing its id, that tokens carry their own company, that a second
 * user cannot be added to a company, and that the same email cannot sign up twice. Prints one line per step;
 * exit code 1 when any step fails.
 */
const BASE = (process.env.BASE || 'http://localhost:4000').replace(/\/+$/, '') + '/api/v1';
const stamp = Date.now();
let failed = 0;

async function call(method, path, { token, body, headers } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, data };
}

async function step(name, fn) {
  try {
    const detail = await fn();
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name} — ${err.message}`);
  }
}
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const decode = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

async function signUp(label) {
  const email = `owner-${label}-${stamp}@example.test`;
  const r = await call('POST', '/auth/register', {
    body: { company_name: `Công ty ${label.toUpperCase()} ${stamp}`, full_name: `Chủ ${label.toUpperCase()}`, email, password: `MatKhau-${label}-123` },
  });
  expect(r.status === 201, `register ${label}: HTTP ${r.status} ${JSON.stringify(r.data)}`);
  return { email, token: r.data.access_token, refresh: r.data.refresh_token, me: r.data };
}

async function sourceId(token) {
  const r = await call('GET', '/settings/options?group=contact_source', { token });
  const rows = Array.isArray(r.data) ? r.data : (r.data?.data ?? r.data?.items ?? []);
  expect(rows.length > 0, `no contact sources: HTTP ${r.status}`);
  return rows[0].id;
}

const A = {};
const B = {};

await step('sign-up is open', async () => {
  const r = await call('GET', '/auth/signup-enabled');
  expect(r.status === 200 && r.data.enabled === true, `HTTP ${r.status} ${JSON.stringify(r.data)}`);
});

await step('company A and company B sign up', async () => {
  Object.assign(A, await signUp('a'));
  Object.assign(B, await signUp('b'));
  A.cid = decode(A.token).cid;
  B.cid = decode(B.token).cid;
  expect(A.cid && B.cid && A.cid !== B.cid, `cid A=${A.cid} B=${B.cid}`);
  expect(A.me.company?.single_user === true, 'company.single_user should be true');
  return `cid A=${A.cid}, B=${B.cid}`;
});

await step('a ?cid= hint on the public sign-up route does not break it', async () => {
  const email = `owner-hint-${stamp}@example.test`;
  const r = await call('POST', '/auth/register?cid=1', {
    body: { company_name: `Công ty gợi ý ${stamp}`, full_name: 'Chủ gợi ý', email, password: 'MatKhau-hint-123' },
    headers: { 'x-trinity-company': '1' },
  });
  expect(r.status === 201, `HTTP ${r.status} ${JSON.stringify(r.data)}`);
  expect(decode(r.data.access_token).cid > 1, 'token should carry the new company');
});

await step('same email cannot sign up twice', async () => {
  const r = await call('POST', '/auth/register', {
    body: { company_name: 'Trùng', full_name: 'Trùng', email: A.email, password: 'MatKhau-x-123' },
  });
  expect(r.status === 409, `HTTP ${r.status}`);
});

await step('each owner logs in to their own company', async () => {
  const r = await call('POST', '/auth/login', { body: { email: A.email.toUpperCase(), password: 'MatKhau-a-123' } });
  expect(r.status === 200, `HTTP ${r.status}`);
  expect(decode(r.data.access_token).cid === A.cid, 'login token cid mismatch');
  const me = await call('GET', '/auth/me', { token: r.data.access_token });
  expect(me.data.user.email === A.email && me.data.company.id === A.cid, JSON.stringify(me.data.company));
});

await step('company A creates a contact', async () => {
  const r = await call('POST', '/contacts', {
    token: A.token,
    body: { full_name: 'Khách bí mật của A', phone: '0911000001', source_id: await sourceId(A.token) },
  });
  expect(r.status === 201 || r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.data)}`);
  A.contactId = r.data.contact?.id ?? r.data.id ?? r.data.data?.id;
  expect(A.contactId, 'no id');
  return `id ${A.contactId}`;
});

await step('company B does not see it in its list or search', async () => {
  const list = await call('GET', '/contacts', { token: B.token });
  expect(list.status === 200, `list HTTP ${list.status}`);
  const text = JSON.stringify(list.data);
  expect(!text.includes('Khách bí mật của A'), 'A contact leaked into B list');
  const search = await call('GET', '/contacts/search?q=0911000001', { token: B.token });
  expect(!JSON.stringify(search.data).includes('Khách bí mật của A'), 'A contact leaked into B search');
});

await step('company B cannot open, edit, delete or restore it by guessing the id', async () => {
  const id = A.contactId;
  const get = await call('GET', `/contacts/${id}`, { token: B.token });
  const patch = await call('PATCH', `/contacts/${id}`, { token: B.token, body: { full_name: 'hacked' } });
  const del = await call('DELETE', `/contacts/${id}`, { token: B.token });
  const restore = await call('POST', `/contacts/${id}/restore`, { token: B.token });
  for (const [what, r] of Object.entries({ get, patch, del, restore })) {
    expect(r.status === 404 || r.status === 403, `${what}: HTTP ${r.status}`);
    expect(!JSON.stringify(r.data).includes('Khách bí mật'), `${what} leaked data`);
  }
  const still = await call('GET', `/contacts/${id}`, { token: A.token });
  expect(still.status === 200 && JSON.stringify(still.data).includes('Khách bí mật của A'), `A lost its contact: ${still.status}`);
  return `GET ${get.status}, PATCH ${patch.status}, DELETE ${del.status}, restore ${restore.status}`;
});

await step('a forged token claiming company A is rejected', async () => {
  const [h, , s] = B.token.split('.');
  const p = Buffer.from(JSON.stringify({ ...decode(B.token), cid: A.cid })).toString('base64url');
  const r = await call('GET', '/contacts', { token: `${h}.${p}.${s}` });
  expect(r.status === 401, `HTTP ${r.status}`);
});

await step('a ?cid= hint cannot switch a signed-in request to another company', async () => {
  const r = await call('GET', `/contacts/${A.contactId}?cid=${A.cid}`, { token: B.token, headers: { 'x-trinity-company': String(A.cid) } });
  expect(r.status === 404 || r.status === 403, `HTTP ${r.status}`);
});

await step('a signed-up company cannot add a second user', async () => {
  const r = await call('POST', '/users', {
    token: A.token,
    body: { email: `staff-${stamp}@example.test`, password: 'MatKhau-staff-1', full_name: 'Nhân viên', role_ids: [] },
  });
  expect(r.status === 409 || r.status === 403 || r.status === 400, `HTTP ${r.status} ${JSON.stringify(r.data)}`);
  return `HTTP ${r.status}: ${r.data?.message ?? ''}`;
});

await step('refresh keeps the company', async () => {
  const r = await call('POST', '/auth/refresh', { body: { refresh_token: B.refresh } });
  expect(r.status === 200 && decode(r.data.access_token).cid === B.cid, `HTTP ${r.status}`);
});

if (process.env.LEGACY_EMAIL) {
  await step('company 1 (existing data) still logs in and keeps its own data', async () => {
    const r = await call('POST', '/auth/login', { body: { email: process.env.LEGACY_EMAIL, password: process.env.LEGACY_PASSWORD } });
    expect(r.status === 200, `HTTP ${r.status}`);
    const cid = decode(r.data.access_token).cid;
    expect(cid === 1 || cid === undefined, `cid ${cid}`);
    const list = await call('GET', '/contacts', { token: r.data.access_token });
    expect(!JSON.stringify(list.data).includes('Khách bí mật của A'), 'A contact leaked into company 1');
    const get = await call('GET', `/contacts/${A.contactId}`, { token: r.data.access_token });
    expect(!JSON.stringify(get.data).includes('Khách bí mật của A'), 'company 1 can open A contact');
    return `company 1 GET A's id → ${get.status}`;
  });
}

console.log(failed ? `\n${failed} step(s) failed` : '\nall steps passed');
process.exit(failed ? 1 : 0);
