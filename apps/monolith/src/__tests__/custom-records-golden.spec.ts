/**
 * Golden của M18 cho bản Rust (`server/crates/mod-custom`): chạy MÃ NODE THẬT (chuẩn hoá giá trị bản ghi, ô CSV, tiêu đề, thẻ @,
 * mã, tham chiếu, con trỏ, công thức của bản ghi) trên bộ đầu vào dùng chung; Rust phải ra đúng kết quả.
 * Sinh lại (múi giờ UTC, vì chuỗi ngày giờ không có múi giờ hiểu theo giờ máy):
 * `TZ=UTC UPDATE_GOLDEN=1 pnpm --filter @trinity/monolith exec jest src/__tests__/custom-records-golden`.
 * Không có trong bộ: chuỗi ngày kiểu V8 không phải ISO ("March 7, 2026") — Node nhận, Rust từ chối.
 */
import * as fs from 'fs'
import * as path from 'path'

import { normalizeValue, ValueError } from '../../../../services/crm/src/custom-objects/field-values'
import { csvCell, exportValue, vnDate, vnDateTime } from '../../../../services/crm/src/custom-objects/csv-format'
import { titleOf } from '../../../../services/crm/src/custom-objects/record-events'
import { extractMentionCodes, parseRef } from '../../../../services/crm/src/custom-objects/refs/ref-types'
import { formatCode, parseCode } from '../../../../services/crm/src/custom-objects/record-codes'
import { decodeCursor, encodeCursor } from '../../../../services/crm/src/custom-objects/record-query'
import { computeFormulas } from '../../../../services/crm/src/custom-objects/record-presenter.service'

const FILE = path.resolve(__dirname, '../../../../server/crates/mod-custom/tests/fixtures/records.json')
const rep = (s: string, n: number): string => s.repeat(n)
const CH = { choices: [{ value: 'moi', label: 'Mới' }, { value: 'dk', label: 'Đã đăng ký' }] }
const ids = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1)
const toks = (n: number): string[] => Array.from({ length: n }, (_, i) => `HS${i + 1}`)

type Field = { label: string; type: string; options: Record<string, unknown> }
const F = (type: string, options: Record<string, unknown> = {}): Field => ({ label: 'Nhãn', type, options })

const VALUES: Array<[Field, unknown[]]> = [
  [F('text'), ['  a ', '', '   ', null, 5, rep('x', 500), rep('x', 501), 'a\u0001b', 'a\tb', rep('😀', 250), rep('😀', 251), true, [], {}, ['a']]],
  [F('long_text'), [rep('x', 10000), rep('x', 10001), ' dài ', 'a\u0000b']],
  [F('number'), [5, '5', ' -5.5 ', '1e3', 'abc', 1e15, 1000000000000001, true, {}, 0, '0', '-0', 1.25, '007', '1.', '.5', 123456789012345]],
  [F('currency'), [5, '1500000', 1.5, -1, 1e13, 10000000000001, 9007199254740993, 0, '10', '-5', 'x', 3.0]],
  [F('percent'), [5, -1000, 1000, 1000.5, -1000.5, '50', 'x', 12.34]],
  [F('date'), ['2026-11-27', '2026-02-30', '0099-01-01', '2026-1-1', '  2026-11-27 ', 5, '2026-11-27T00:00', '2024-02-29', '2025-02-29', '9999-12-31', '0100-01-01']],
  [F('datetime'), ['2026-11-27T10:30:00+07:00', '2026-11-27', '2026-11-27 10:30', '2026-11-27T10:30:00.123456Z', '1899-12-31T23:59:59Z', '1900-01-01T00:00:00Z', '2200-01-01T00:00:00Z', '2200-01-01T00:00:01Z', 'x', '2026-13-01', '2026-02-30T10:00', '2026-11-27T24:00:00Z', '2026-11-27T10:30', '2026-11-27T10:30:00-0530', '2026', '2026-11', 5]],
  [F('boolean'), [true, false, 'true', 'false', 'TRUE', 1, 0, 'yes', null, '']],
  [F('select', CH), ['moi', ' dk ', 'zzz', 5, '', 'Mới', rep('z', 70)]],
  [F('email'), ['A@B.vn', 'a@b', 'a b@c.vn', ' X@Y.COM ', 'a@b.c', 'a@b.cc', '@b.vn', 'a@@b.vn', `${rep('a', 65)}@b.vn`, `${rep('a', 64)}@b.vn`, 'é@b.vn', 5, 'a@b.vn,c@d.vn']],
  [F('phone'), ['0901234567', '+84 901 234 567', '84901234567', '(090) 123.4567', '901234567', '09012345678', '+8490123456', 'abc', '0901-234-567', '+84901234567']],
  [F('url'), ['https://a.vn', 'http://a', 'ftp://a', 'a.vn', 'javascript:alert(1)', ' https://a.vn/x?y=1 ', 'https://', 'http://exa mple.com', 'HTTP://A.VN', 'https://a.vn/ü', 'mailto:a@b.vn']],
  [F('user'), [5, '5', 0, -1, 1.5, 'abc', true, [5], 9007199254740993, '007', ' 5']],
  [F('multi_select', CH), [['moi', 'dk'], ['moi', 'moi'], ['zzz'], 'moi', [5], [], ['moi', 'x'], ids(51).map(() => 'moi'), [' moi ']]],
  [F('relation', { target_object_id: 7, multiple: false }), [5, '5', [5, 6], 0, [], 'x', 1.5, true]],
  [F('relation', { target_object_id: 7, multiple: true }), [[1, 2, 2], [1, '2'], [0], 5, ids(50), ids(51), 'x', [1.5]]],
  [F('link'), [['HS001'], 'HS001, KH002', '@hs1;record:5', ['x y'], [rep('a', 31)], 5, [5], toks(50), toks(51), 'record:12 contact:3', ['@HS1', 'hs1'], ['record:12345678901', 'AB1234567890'], [''], '  ', ['KH0001']]],
  [F('formula', { expression: '1' }), [5, null, '']],
]

const FORMULA_FIELDS = [
  { key: 'gia', type: 'currency', label: 'Giá', options: {} },
  { key: 'pt', type: 'percent', label: 'PT', options: {} },
  { key: 'sl', type: 'number', label: 'SL', options: {} },
  { key: 'ngay', type: 'date', label: 'Ngày', options: {} },
  { key: 'gio', type: 'datetime', label: 'Giờ', options: {} },
  { key: 'ten', type: 'text', label: 'Tên', options: {} },
  { key: 'a', type: 'formula', label: 'A', options: { expression: '{gia}*2+{pt}' } },
  { key: 'b', type: 'formula', label: 'B', options: { expression: '{gia}/{sl}' } },
  { key: 'c', type: 'formula', label: 'C', options: { expression: '{gia}*{pt}' } },
  { key: 'd', type: 'formula', label: 'D', options: { expression: 'DAYS({ngay}, TODAY())' } },
  { key: 'e', type: 'formula', label: 'E', options: { expression: '{khong_co}' } },
  { key: 'f', type: 'formula', label: 'F', options: { expression: '(' } },
  { key: 'g', type: 'formula', label: 'G', options: {} },
  { key: 'h', type: 'formula', label: 'H', options: { expression: '{ten}' } },
  { key: 'i', type: 'formula', label: 'I', options: { expression: '{a}+1' } },
  { key: 'j', type: 'formula', label: 'J', options: { expression: 'ROUND({sl}/3, 2)' } },
]
const FORMULA_DATA: Array<Record<string, unknown>> = [
  {}, { gia: 1500000, pt: 10, sl: 3 }, { gia: 100, sl: 0 }, { gia: 7, pt: 50, sl: 3, ngay: '2026-01-01', ten: 'x' },
  { gia: '5', pt: 'x', sl: null }, { gia: 1e12, pt: 1000, sl: 1e-7 }, { sl: 10 }, { gia: 10, pt: -5, sl: 1.5, gio: '2026-11-27T10:00:00.000Z' },
]

const CSV_CELLS: unknown[] = ['=1', '+1', '-1', '@a', '\tx', '\rx', 'a,b', 'a"b', 'a\nb', 'a\r\nb', 5, -5, 1.5, true, false, null, '', 'ok', "'=x", ' =x', '=a,b', '-', 'Nguyễn', 1e21, 0.1 + 0.2, -0]

const EXPORT_FIELDS: Array<[Field & { key: string }, unknown, Record<string, unknown>]> = [
  [{ key: 'd', ...F('date') }, '2026-11-27', {}],
  [{ key: 'd', ...F('date') }, 'xx', {}],
  [{ key: 'g', ...F('datetime') }, '2026-11-27T17:30:00.000Z', {}],
  [{ key: 'g', ...F('datetime') }, 'xx', {}],
  [{ key: 'b', ...F('boolean') }, true, {}],
  [{ key: 'b', ...F('boolean') }, false, {}],
  [{ key: 's', ...F('select', CH) }, 'dk', {}],
  [{ key: 's', ...F('select', CH) }, 'khong-co', {}],
  [{ key: 'm', ...F('multi_select', CH) }, ['moi', 'dk', 'q'], {}],
  [{ key: 'r', ...F('relation', { target: 'contact' }) }, 5, { r: { id: 5, title: 'Bình', accessible: true } }],
  [{ key: 'r', ...F('relation', { target: 'contact' }) }, 5, { r: { id: 5, title: null, accessible: false } }],
  [{ key: 'u', ...F('user') }, 5, { u: { id: 5, title: 'An', accessible: true } }],
  [{ key: 'l', ...F('link') }, ['record:1', 'record:2', 'record:3'], { l: [{ id: 1, type: 'record', title: 'Một', accessible: true, code: 'HS001' }, { id: 2, type: 'record', title: null, accessible: false }, { id: 3, type: 'record', title: 'Ba', accessible: true, code: null }] }],
  [{ key: 't', ...F('text') }, '=cmd', {}],
  [{ key: 'n', ...F('number') }, 12.5, {}],
  [{ key: 'n', ...F('number') }, 0, {}],
  [{ key: 'p', ...F('phone') }, '***567', {}],
  [{ key: 'x', ...F('text') }, undefined, {}],
]

const TITLE_DATA: unknown[] = ['  abc ', 5, true, '', '   ', rep('x', 250), null, [1, 2], { a: 1 }, rep('😀', 101), 0, false, 'ok']
const MENTIONS: string[] = [
  'Gặp @hs1 và @KH012, @hs001 lại.', 'mail a@hs001.vn x@@hs2 @hs3x @h1 @hs1234567890 Ahs@hs4', '@AB1000 @ab9', '@ab1 @cd2 @ef3', '@hs1\n@hs2', '(@hs5)',
  '@hs0', '@hs000001', '@Hs12_x', '@hs1é', 'é@hs1', '@hs1.', '@hs1-@hs2', '', 'không có', '@ab123456789 @ab1234567890', '_@hs1', '1@hs1', '@HS1@HS2',
]
const REFS: unknown[] = ['record:12', ' record:12 ', 'contact:5', 'deal:3', 'task:9', 'record:0', 'record:99999999999', 'record:1.5', 'x:1', 'RECORD:1', 5, null, '', 'record:007']
const CODES: string[] = ['hs1', 'HS001', ' hs12 ', 'HS1000', 'hs0', 'h1', 'hsxyz1', 'hs', 'hs1234567890', 'HS-1', '', 'ab999999999']
const CURSORS: Array<{ v: string | null; id: number }> = [{ v: null, id: 3 }, { v: 'a"b', id: 7 }, { v: 'Nguyễn', id: 1 }, { v: '12.5', id: 99 }, { v: '', id: 0 }]
const CURSOR_RAW: string[] = ['', '!!!', 'e30', 'eyJpZCI6MX0', 'eyJ2IjpudWxsLCJpZCI6NX0', 'eyJ2IjpudWxsLCJpZCI6NX0=', 'eyJ2IjpudWxsLCJpZCI6MS41fQ', 'eyJ2Ijo1LCJpZCI6MX0', 'eyJ2IjoiYSIsImlkIjoiMSJ9', 'W10', 'bnVsbA']
const DATES: string[] = ['2026-11-27', '2026-11-27T10:00:00Z', 'xx', '', '2026-11-27 10:00', '2026-11-27T17:30:00.000Z', '2026-12-31T20:00:00Z']

function attempt<T>(fn: () => T): { ok: T } | { error: string } {
  try {
    return { ok: fn() }
  } catch (e) {
    if (e instanceof ValueError || e instanceof Error) return { error: e.message }
    throw e
  }
}

function build(): Record<string, unknown> {
  const values: unknown[] = []
  for (const [field, raws] of VALUES) {
    for (const raw of raws) values.push({ field, raw, result: attempt(() => { const v = normalizeValue(field as never, raw); return v === undefined ? null : v }) })
  }
  const formulas = FORMULA_DATA.map((data) => ({ data, result: computeFormulas(FORMULA_FIELDS as never, data) }))
  const csv_cells = CSV_CELLS.map((v) => ({ value: v === 0 && Object.is(v, -0) ? '-0' : v, cell: csvCell(v === 0 && Object.is(v, -0) ? '-0' : v) }))
  const export_values = EXPORT_FIELDS.map(([field, v, relations]) => {
    const data: Record<string, unknown> = {}
    if (v !== undefined) data[field.key] = v
    return { field, data, relations, result: exportValue(field as never, { data, relations } as never) ?? null }
  })
  const titles = TITLE_DATA.map((v) => ({ value: v, title: titleOf({ fields: [{ key: 't', is_title: true }] } as never, { t: v } as never) }))
  titles.push({ value: '(không có trường tiêu đề)', title: titleOf({ fields: [{ key: 't', is_title: false }] } as never, { t: 'x' } as never) })
  const mentions = MENTIONS.flatMap((text) => [{ text, max: 50, codes: extractMentionCodes(text) }, { text, max: 2, codes: extractMentionCodes(text, 2) }])
  const refs = REFS.map((raw) => ({ raw, ref: parseRef(raw) }))
  const codes = CODES.map((raw) => ({ raw, parsed: parseCode(raw) }))
  const formats = [[1, 'HS'], [12, 'HS'], [999, 'HS'], [1000, 'HS'], [123456, 'AB']].map(([n, p]) => ({ prefix: p, seq: n, code: formatCode(p as string, n as number) }))
  const cursors = CURSORS.map((c) => ({ cursor: c, encoded: encodeCursor(c) }))
  const cursor_raw = CURSOR_RAW.map((raw) => ({ raw, result: attempt(() => decodeCursor(raw)) }))
  const dates = DATES.map((raw) => ({ raw, date: vnDate(raw), datetime: vnDateTime(raw) }))
  return { values, formulas, csv_cells, export_values, titles, mentions, refs, codes, formats, cursors, cursor_raw, dates }
}

describe('custom records golden', () => {
  it('mã Node thật cho giá trị, ô CSV, tiêu đề, thẻ @, mã, con trỏ, công thức bản ghi', () => {
    const text = `${JSON.stringify(build(), null, 1)}\n`
    if (process.env.UPDATE_GOLDEN === '1') {
      fs.mkdirSync(path.dirname(FILE), { recursive: true })
      fs.writeFileSync(FILE, text)
    }
    expect(fs.readFileSync(FILE, 'utf8')).toBe(text)
  })
})
