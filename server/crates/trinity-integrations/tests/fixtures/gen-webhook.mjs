// Sinh webhook.json từ bản Node thật: node --experimental-strip-types tests/fixtures/gen-webhook.mjs > tests/fixtures/webhook.json (chạy ở server/crates/trinity-integrations)
import { register } from 'node:module'
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, n) { if (s === '@trinity/rbac-nest') return { url: new URL('./stub-rbac.mjs', 'file://${process.cwd()}/tests/fixtures/').href, shortCircuit: true }; return n(s, c) }`))
const root = '../../../../../services/crm/src/integrations/webhooks/'
const { evaluateEvent } = await import(new URL(root + 'webhook-payload.ts', import.meta.url).href)
const { computeSignature, buildSignatureHeader, verifySignatureHeader } = await import(new URL(root + 'signature.ts', import.meta.url).href)
const { encryptSecret, decryptSecret, loadSecretKey } = await import(new URL(root + 'secret-crypto.ts', import.meta.url).href)
const { nextRetryDelayMs } = await import(new URL(root + 'webhook-retry.ts', import.meta.url).href)

const sig = ['{"a":1}', '{"tên":"Nguyễn Văn A","emoji":"😀"}', '', 'x'.repeat(5000)].map((body, i) => {
  const secret = ['whsec_abc', 'k', 'bí mật', 'whsec_' + 'z'.repeat(43)][i]
  const t = 1_700_000_000 + i
  return { secret, t, body, sig: computeSignature(secret, t, body), header: buildSignatureHeader(secret, body, t * 1000 + 999) }
})
const nowMs = 1_700_000_100_000
const good = computeSignature('s', 1_700_000_000, 'b')
const verify = [
  ['hợp lệ', `t=1700000000,v1=${good}`], ['quá hạn', `t=1699999000,v1=${good}`], ['t tương lai quá xa', `t=1700001000,v1=${good}`],
  ['sai chữ ký', `t=1700000000,v1=${'0'.repeat(64)}`], ['hai v1 một đúng', `t=1700000000,v1=${'1'.repeat(64)},v1=${good}`],
  ['hoa', `t=1700000000,v1=${good.toUpperCase()}`], ['thiếu t', `v1=${good}`], ['thiếu v1', 't=1700000000'], ['khoảng trắng', ` t = 1700000000 , v1 = ${good} `],
  ['t 13 chữ số', `t=1700000000000,v1=${good}`], ['rỗng', ''], ['dài', 'a=1,'.repeat(200)],
].map(([name, header]) => ({ name, header, ok: verifySignatureHeader('s', 'b', header, { nowMs }) }))

const key = Buffer.alloc(32, 7)
const enc = ['whsec_abc', 'tiếng Việt 😀', ''].map((p) => ({ plain: p, enc: encryptSecret(p, key) }))
const retry = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ attempts: n, ms: nextRetryDelayMs(n) }))
const keys = ['', '  ', 'abc', Buffer.alloc(32, 1).toString('base64'), Buffer.alloc(32, 255).toString('base64url'), Buffer.alloc(31).toString('base64'), Buffer.alloc(32).toString('base64') + '=', Buffer.alloc(32).toString('base64') + '===', 'QUJD!'].map((k) => {
  try { loadSecretKey({ INTEGRATIONS_SECRET_KEY: k }); return { raw: k, ok: true } } catch { return { raw: k, ok: false } }
})

const S = { contactsView: 'all', dealsView: 'all', posSell: 'all', phoneFull: 'all', customView: 'all', customPhoneFull: 'all', roleIds: [], canManageCustomObjects: false, canSocialPost: true }
const scopesList = {
  admin: S, none: { ...S, contactsView: null, dealsView: null, posSell: null, customView: null, canSocialPost: false },
  masked: { ...S, phoneFull: null, customPhoneFull: null }, own7: { ...S, contactsView: [7], dealsView: [7], posSell: [7], phoneFull: [7], customView: [7], customPhoneFull: [7], roleIds: [3] },
  scoped: { ...S, contactsView: [7], dealsView: [7], posSell: [7], phoneFull: [], customView: [7], customPhoneFull: [], roleIds: [3] },
}
const contact = (o = {}) => ({ contact: { id: 1, full_name: 'Lan 0912345678', phone: '0912345678', phone_2: '***678', zalo_account: '0987654321', email: '0912345678@gmail.com', assigned_to: 7, created_by_id: 8, ...o } })
const payloads = [
  ['contact.created', contact()], ['contact.updated', contact({ assigned_to: 9 })], ['contact.assigned', { ...contact({ assigned_to: 9, created_by_id: 9 }), from_user_id: 7, to_user_id: 9, reason: 'giao 0911222333 chăm' }],
  ['contact.deleted', contact({ assigned_to: null, created_by_id: null, zalo_account: 'abc' })],
  ['deal.created', { deal: { id: 1, title: 'Deal 0912345678', description: 'gọi 091 234 5678', note: 'x', assigned_to: 7, created_by: 1 } }],
  ['deal.won', { deal: { id: 1, title: 't', assigned_to: 9, created_by: 9 } }],
  ['pos.order.completed', { order: { id: 1, note: 'sdt 0912345678', created_by: 7, paid_by: 2, payments: [{ reference: 'ref 0912345678' }, 5, null] } }],
  ['custom_record.created', { object: { key: 'o', is_active: true, visible_role_ids: [3] }, record: { id: 1, title: 'KH 0912345678', owner_id: 7, created_by: 7, phone_fields: ['sdt'], data: { sdt: '0912345678', ghi_chu: 'gọi 0912345678', n: 5 } } }],
  ['custom_record.updated', { object: { key: 'o', is_active: false, visible_role_ids: [] }, record: { id: 1, owner_id: 7, created_by: 7, data: {} } }],
  ['custom_record.deleted', { object: { key: 'o', is_active: true, visible_role_ids: [4] }, record: { id: 1, owner_id: 7, created_by: 7, data: {} } }],
  ['custom_record.created', { object: { key: 'o' }, record: null }],
  ['zalo_oa.message_received', { contact_assigned_to: 7, thread_id: 1 }], ['messenger.message_sent', { contact_assigned_to: 9 }], ['facebook.comment_received', { contact_assigned_to: null }],
  ['messenger.broadcast_finished', { name: 'Đợt 0912345678', sent: 3 }], ['social_post.published', { post_id: 1 }], ['payment.received', { amount: 5 }],
  ['store_order.created', { order: { customer_phone: '0912345678', customer_name: 'A 0912345678', customer_address: '1 đường 0912345678', note: 'x', contact_assigned_to: 7 } }],
  ['store_order.paid', { order: { customer_phone: '', contact_assigned_to: 9 } }], ['unknown.event', {}], ['contact.created', null], ['contact.created', { contact: 'nope' }],
]
const payload = []
for (const [type, p] of payloads) for (const [name, sc] of Object.entries(scopesList)) {
  const out = evaluateEvent(type, JSON.parse(JSON.stringify(p)), sc)
  payload.push({ type, payload: p, scopes_name: name, scopes: sc, deliver: out.deliver, data: out.deliver ? out.data : null })
}
console.log(JSON.stringify({ sig, verify, now_ms: nowMs, enc, key_b64: key.toString('base64'), retry, keys, payload }, null, 1))
