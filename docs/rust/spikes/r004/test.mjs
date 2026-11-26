import { chromium } from 'playwright-core'
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--host-resolver-rules=MAP *.store.test 127.0.0.1'] })
const BASE = 'http://127.0.0.1:5055'
const cases = {
  A_contact: { id: 'a1', deep: '/a/contacts/123', exp: { id: '123' } },
  A_view: { id: 'a2', deep: '/a/x/khach/v/kanban1', exp: { objectKey: 'khach', viewKey: 'kanban1' } },
  A_store: { id: 'a3', deep: '/a/s/cua-hang-abc', exp: { slug: 'cua-hang-abc' } },
  A_invite: { id: 'a4', deep: '/a/invite/TOKEN-xyz-1', exp: { token: 'TOKEN-xyz-1' } },
  B_contact: { id: 'b1', deep: '/b/contacts/view?id=123', exp: { id: '123' } },
  B_view: { id: 'b2', deep: '/b/x/view?objectKey=khach&viewKey=kanban1', exp: { objectKey: 'khach', viewKey: 'kanban1' } },
  B_store: { id: 'b3', deep: '/b/s/view?slug=cua-hang-abc', exp: { slug: 'cua-hang-abc' } },
  B_invite: { id: 'b4', deep: '/b/invite/accept#TOKEN-xyz-1', exp: { token: 'TOKEN-xyz-1' } },
}
const match = (got, exp) => Object.entries(exp).every(([k, v]) => got[k] === v)
async function mk(url) {
  const ctx = await b.newContext(); const pg = await ctx.newPage(); const msgs = [], bad = []
  pg.on('console', m => { if (['error', 'warning'].includes(m.type())) msgs.push(m.type() + ': ' + m.text().slice(0, 160)) })
  pg.on('pageerror', e => msgs.push('pageerror: ' + e.message.slice(0, 160)))
  pg.on('response', r => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url().replace(BASE, '')) })
  return { pg, msgs, bad }
}
const vals = async pg => { await pg.waitForSelector('#vals', { timeout: 5000 }).catch(() => {}); await pg.waitForTimeout(300); return JSON.parse(await pg.textContent('#vals').catch(() => '{}')) }
const out = {}
for (const [name, c] of Object.entries(cases)) {
  const r = {}
  // 1) URL sâu
  let t = await mk(); await t.pg.goto(BASE + c.deep); r.deep = match(await vals(t.pg), c.exp); r.deepMsgs = t.msgs; r.deepBad = t.bad
  // 2) điều hướng trong app + 3) quay lại + 4) prefetch
  t = await mk(); await t.pg.goto(BASE + '/'); await t.pg.waitForTimeout(1500)
  r.prefetchBad = [...t.bad]
  await t.pg.click('#' + c.id); r.nav = match(await vals(t.pg), c.exp)
  const navUrl = t.pg.url()
  await t.pg.click('#home'); await t.pg.waitForSelector('h1'); await t.pg.goBack(); r.back = match(await vals(t.pg), c.exp) && t.pg.url() === navUrl
  // chuyển hẳn bằng reload sau điều hướng
  await t.pg.reload(); r.reload = match(await vals(t.pg), c.exp)
  r.navMsgs = t.msgs; r.navBad = t.bad
  out[name] = r
}
// tên miền phụ cho cửa hàng (A): URL là /
{
  const t = await mk(); await t.pg.goto('http://cua-hang-abc.store.test:5055/'); const v = await vals(t.pg)
  out.A_store_subdomain = { vals: v, msgs: t.msgs, bad: t.bad }
}
console.log(JSON.stringify(out, null, 1)); await b.close()
