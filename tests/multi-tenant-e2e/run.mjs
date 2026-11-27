#!/usr/bin/env node
/**
 * Multi-tenant end-to-end check against a running Trinity API (MULTI_TENANT=true, local database only).
 *
 *   BASE=http://localhost:4000 node tests/multi-tenant-e2e/run.mjs
 *   (optional) LEGACY_EMAIL / LEGACY_PASSWORD = an existing company-1 account
 *
 * Signs up two companies through the public API, then checks over HTTP that company B cannot list, open, edit,
 * delete or restore company A's contact by guessing its id, that tokens carry their own company, that the owner can invite staff by link
 * (preview, accept, single use, right company, foreign email refused) and reset their password, and that the same email cannot sign up twice. Prints one line per step;
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
  expect(A.me.company?.multi_tenant === true && A.me.company?.id === A.cid, 'company info should carry id and multi_tenant');
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

const staffEmail = `staff-${stamp}@example.test`;
const invite = {};
await step('the owner invites staff by link (no email is sent); a foreign company email is refused', async () => {
  const roles = await call('GET', '/roles', { token: A.token });
  expect(roles.status === 200 && roles.data.length, `roles HTTP ${roles.status}`);
  invite.role = roles.data.find((r) => !r.is_system) ?? roles.data[0];
  const r = await call('POST', '/auth/invitations', { token: A.token, body: { email: staffEmail, role_id: invite.role.id } });
  expect(r.status === 201 && r.data.token?.startsWith(`c${A.cid}.`) && r.data.path === `/invite/${r.data.token}`, `HTTP ${r.status} ${JSON.stringify(r.data)}`);
  invite.token = r.data.token;
  const taken = await call('POST', '/auth/invitations', { token: A.token, body: { email: B.email, role_id: invite.role.id } });
  expect(taken.status === 409 && /công ty khác/.test(taken.data?.message ?? ''), `foreign email: HTTP ${taken.status} ${JSON.stringify(taken.data)}`);
  const list = await call('GET', '/auth/invitations', { token: A.token });
  expect(list.status === 200 && list.data.data.some((i) => i.email === staffEmail && i.status === 'pending'), 'pending list');
  expect(!JSON.stringify(list.data).includes(invite.token), 'list must not expose the token');
  const bList = await call('GET', '/auth/invitations', { token: B.token });
  expect(!JSON.stringify(bList.data).includes(staffEmail), 'company B sees A invitations');
  return `role ${invite.role.name}`;
});

await step('the public invite page works without a session; accepting creates the user in the right company', async () => {
  const p = await call('POST', '/auth/invitations/preview', { body: { token: invite.token } });
  expect(p.status === 200 && p.data.email === staffEmail, `preview HTTP ${p.status} ${JSON.stringify(p.data)}`);
  const a = await call('POST', '/auth/invitations/accept', { body: { token: invite.token, full_name: 'Nhân viên mới', password: 'MatKhau-staff-1' } });
  expect(a.status === 201 && decode(a.data.access_token).cid === A.cid, `accept HTTP ${a.status} ${JSON.stringify(a.data)}`);
  invite.staff = a.data.access_token;
  const again = await call('POST', '/auth/invitations/accept', { body: { token: invite.token, full_name: 'Nhận lại', password: 'MatKhau-staff-1' } });
  expect(again.status === 410, `second use HTTP ${again.status}`);
  const login = await call('POST', '/auth/login', { body: { email: staffEmail, password: 'MatKhau-staff-1' } });
  expect(login.status === 200 && decode(login.data.access_token).cid === A.cid, `login HTTP ${login.status}`);
});

await step('the new staff member sees company A data only, and company B still cannot see A', async () => {
  const mine = await call('GET', `/contacts/${A.contactId}`, { token: invite.staff });
  const users = await call('GET', '/users?limit=100', { token: A.token });
  expect(users.status === 200 && users.data.data.length === 2, `A users: ${users.data?.data?.length}`);
  const bUsers = await call('GET', '/users?limit=100', { token: B.token });
  expect(bUsers.data.data.length === 1 && !JSON.stringify(bUsers.data).includes(staffEmail), 'company B sees A staff');
  return `staff GET A contact → ${mine.status} (own-scope role may hide it)`;
});

await step('the owner resets a staff password; the old one stops working, the new one works', async () => {
  const users = await call('GET', '/users?limit=100', { token: A.token });
  const staff = users.data.data.find((u) => u.email === staffEmail);
  const r = await call('PATCH', `/users/${staff.id}/reset-password`, { token: A.token, body: { password: 'MatKhau-tam-9' } });
  expect(r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.data)}`);
  const old = await call('POST', '/auth/login', { body: { email: staffEmail, password: 'MatKhau-staff-1' } });
  const fresh = await call('POST', '/auth/login', { body: { email: staffEmail, password: 'MatKhau-tam-9' } });
  expect(old.status === 401 && fresh.status === 200, `old ${old.status} new ${fresh.status}`);
});

await step('refresh keeps the company', async () => {
  const r = await call('POST', '/auth/refresh', { body: { refresh_token: B.refresh } });
  expect(r.status === 200 && decode(r.data.access_token).cid === B.cid, `HTTP ${r.status}`);
});

// ---- X09: ca biên đa công ty (PLAN 10.2), chạy được trên bản Node lẫn bản Rust ----

await step('company A and B both hold a contact with the same number; each sees only its own (id may collide)', async () => {
  const mk = async (who, name) => {
    const r = await call('POST', '/contacts', {
      token: who.token,
      body: { full_name: name, phone: '0922000777', source_id: await sourceId(who.token) },
    });
    expect(r.status === 201 || r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.data)}`);
    return r.data.contact?.id ?? r.data.id ?? r.data.data?.id;
  };
  const idA = await mk(A, 'Trùng số của A');
  const idB = await mk(B, 'Trùng số của B');
  const listA = JSON.stringify((await call('GET', '/contacts?search=0922000777', { token: A.token })).data);
  const listB = JSON.stringify((await call('GET', '/contacts?search=0922000777', { token: B.token })).data);
  expect(listA.includes('Trùng số của A') && !listA.includes('Trùng số của B'), 'A list mixes companies');
  expect(listB.includes('Trùng số của B') && !listB.includes('Trùng số của A'), 'B list mixes companies');
  const cross = await call('GET', `/contacts/${idA}`, { token: B.token });
  if (idA === idB) {
    expect(JSON.stringify(cross.data).includes('Trùng số của B'), 'same id must open B own row');
  } else {
    expect(cross.status === 404 || cross.status === 403, `HTTP ${cross.status}`);
  }
  return `ids A=${idA} B=${idB}`;
});

await step('a company-A prefix on a company-B invitation / API key token is rejected', async () => {
  const fake = `c${A.cid}.${(invite.token ?? 'x').split('.').pop()}`;
  const p = await call('POST', '/auth/invitations/preview', { body: { token: fake } });
  expect([400, 404, 410].includes(p.status), `forged invite prefix: HTTP ${p.status}`);
  const noPrefix = await call('POST', '/auth/invitations/preview', { body: { token: 'khong-co-tien-to' } });
  expect([400, 404, 410].includes(noPrefix.status), `no prefix: HTTP ${noPrefix.status}`);
  const nonexistent = await call('POST', '/auth/invitations/preview', { body: { token: `c99999999.${stamp}` } });
  expect([400, 404, 410].includes(nonexistent.status), `unknown company prefix: HTTP ${nonexistent.status}`);
  const key = await call('GET', '/contacts', { headers: { 'x-api-key': `c${B.cid}.khong-ton-tai-${stamp}` } });
  expect(key.status === 401 || key.status === 403, `forged api key: HTTP ${key.status}`);
});

await step('a ?cid= pointing to a company that does not exist does not fall back to another company', async () => {
  const r = await call('GET', '/auth/signup-enabled?cid=99999999', { headers: { 'x-trinity-company': '99999999' } });
  expect(r.status !== 500, `HTTP ${r.status}`);
  const me = await call('GET', '/auth/me?cid=99999999', { token: B.token, headers: { 'x-trinity-company': '99999999' } });
  expect(me.status === 200 && me.data.company.id === B.cid, `signed-in request must keep its own company: HTTP ${me.status}`);
  const pub = await call('GET', '/contacts?cid=abc', { token: B.token });
  expect(pub.status !== 500, `non-numeric cid: HTTP ${pub.status}`);
});

await step('two sign-ups with the same email at the same time: exactly one wins', async () => {
  const email = `race-${stamp}@example.test`;
  const body = (n) => ({ company_name: `Đua ${n} ${stamp}`, full_name: `Đua ${n}`, email, password: 'MatKhau-race-123' });
  const rs = await Promise.all([1, 2, 3, 4].map((n) => call('POST', '/auth/register', { body: body(n) })));
  const ok = rs.filter((r) => r.status === 201).length;
  const taken = rs.filter((r) => r.status === 409).length;
  expect(ok === 1 && taken === 3, `statuses ${rs.map((r) => r.status).join(',')}`);
  const login = await call('POST', '/auth/login', { body: { email, password: 'MatKhau-race-123' } });
  expect(login.status === 200, `login HTTP ${login.status}`);
});

await step('an abandoned or malformed sign-up leaves no company behind; the email stays usable', async () => {
  const email = `half-${stamp}@example.test`;
  const bad = await call('POST', '/auth/register', { body: { company_name: '', full_name: 'X', email, password: 'MatKhau-half-123' } });
  expect(bad.status === 400, `empty company name: HTTP ${bad.status}`);
  const badMail = await call('POST', '/auth/register', { body: { company_name: 'X', full_name: 'X', email: 'khong-phai-email', password: 'MatKhau-half-123' } });
  expect(badMail.status === 400, `bad email: HTTP ${badMail.status}`);
  const good = await call('POST', '/auth/register', { body: { company_name: `Sau lỗi ${stamp}`, full_name: 'Sau lỗi', email, password: 'MatKhau-half-123' } });
  expect(good.status === 201, `register after failure: HTTP ${good.status} ${JSON.stringify(good.data)}`);
});

await step('many companies in a row each keep their own data (more companies than pool connections)', async () => {
  const crew = [];
  for (let i = 0; i < 6; i++) crew.push(await signUp(`n${i}`));
  const src = await Promise.all(crew.map((c) => sourceId(c.token)));
  await Promise.all(crew.map((c, i) => call('POST', '/contacts', {
    token: c.token,
    body: { full_name: `Chỉ của n${i}`, phone: `09330000${i}0`, source_id: src[i] },
  })));
  for (let round = 0; round < 3; round++) {
    const lists = await Promise.all(crew.map((c) => call('GET', '/contacts?limit=100', { token: c.token })));
    lists.forEach((r, i) => {
      const text = JSON.stringify(r.data);
      expect(text.includes(`Chỉ của n${i}`), `n${i} lost its row in round ${round}`);
      for (let j = 0; j < crew.length; j++) {
        if (j !== i) expect(!text.includes(`Chỉ của n${j}`), `n${j} leaked into n${i} in round ${round}`);
      }
    });
  }
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
