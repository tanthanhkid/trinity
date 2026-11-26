// Sinh sanitize.json từ bản Node thật: node --experimental-strip-types tests/fixtures/gen-sanitize.mjs > tests/fixtures/sanitize.json
import { MAX_ERROR, sanitizeMetadata, sanitizeText } from '../../../../../packages/prisma/src/integrations/audit-sanitize.ts'
const texts = [
  'gọi 0912345678 lúc 9h', 'số +84 912 345 678 và 028.3822.1234', 'ngày 2026-11-27 mã 12345678', 'Bearer abc.def-ghi_jkl=',
  'bearer   TOKENxyz', 'khoá ' + 'a'.repeat(40) + ' hết', 'ab'.repeat(20), 'x'.repeat(400), 'đ'.repeat(310), '\ufeff0912\ufeff345\ufeff678', '0912\u0085345\u0085678', 'Bearer\ufefftok', 'Bearer\u0085tok', 'gọi\u00a0091\u2003234\u3000567 8', 'a\u2028b',
  'lỗi 500 tại /api/v1/contacts/123456789', '1 2 3 4 5 6 7 8 9', '12.345.678', '', 'plain',
]
const metas = [
  { phone: '0912345678', name: 'An', api_key: 'sk-123', nested: { token: 'x', msg: 'gọi 0987654321', deep: { a: { b: { c: { d: 1 } } } } } },
  { list: Array.from({ length: 25 }, (_, i) => `item${i}`), n: 3, b: true, z: null },
  Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`k${String(i).padStart(2, '0')}`, i])),
  { Authorization: 'Bearer abc', mobile: '+84 912 345 678', tel: '028 3822 1234', telephone: '1234567890', note: 'Cookie=abc' },
  [1, '0912345678', { token: 'x' }], Array.from({ length: 35 }, (_, i) => i),
  { arr: [{ secret: 1, ok: 'fine' }, [[['deep']]]] }, {}, { s: 'a'.repeat(350) },
]
const errors = ['y '.repeat(450), 'y '.repeat(250), 'y '.repeat(251), 'đ'.repeat(501), 'lỗi 0912345678 ' + 'z '.repeat(400)]
console.log(JSON.stringify({ errors: errors.map((t) => ({ in: t, out: sanitizeText(t, MAX_ERROR) })), texts: texts.map((t) => ({ in: t, out: sanitizeText(t) })), metas: metas.map((m) => ({ in: m, out: sanitizeMetadata(m) })) }, null, 1))
