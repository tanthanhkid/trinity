import * as fs from 'fs'
import * as path from 'path'
import * as Handlebars from 'handlebars'

/**
 * Bảng ca render dùng chung TS ↔ Rust (M32): `server/contracts/cases/notify-templates.json`. Bản Node là chuẩn:
 * mỗi mẫu được biên dịch đúng như `TemplatesService` (`knownHelpersOnly`) rồi render với `data`. Rust chạy cùng bảng ở
 * `server/crates/mod-notify/tests/render_cases.rs` và phải ra đúng từng byte. Sinh lại kết quả: `UPDATE_NOTIFY_CASES=1`.
 */
const FILE = path.resolve(__dirname, '../../../../../server/contracts/cases/notify-templates.json')
const OPTS = { knownHelpersOnly: true, strict: false }

/** `rust_err` / `rust`: lệch có chủ đích của bản Rust (section `{{#ten}}` không hỗ trợ), giữ nguyên khi sinh lại. */
type Render = { template: string; ok?: string; err?: string; rust_err?: boolean }
type Syntax = { template: string; ok: boolean; err?: string; rust?: boolean }
type Table = { _doc: string; data: Record<string, unknown>; render: Render[]; syntax: Syntax[] }

const first = (e: unknown) => String((e as Error).message).split('\n')[0]

describe('ca render và kiểm cú pháp mẫu thông báo (notify-templates.json)', () => {
  const table = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Table
  const fresh: Table = {
    ...table,
    render: table.render.map(({ template, rust_err }) => {
      const flag = rust_err ? { rust_err } : {}
      try {
        return { template, ok: Handlebars.compile(template, OPTS)(table.data), ...flag }
      } catch (e) {
        return { template, err: first(e), ...flag }
      }
    }),
    syntax: table.syntax.map(({ template, rust }) => {
      const flag = rust === undefined ? {} : { rust }
      try {
        Handlebars.precompile(template, OPTS)
        return { template, ok: true, ...flag }
      } catch (e) {
        return { template, ok: false, err: first(e), ...flag }
      }
    }),
  }

  it('kết quả của handlebars.js khớp bảng', () => {
    if (process.env.UPDATE_NOTIFY_CASES === '1') fs.writeFileSync(FILE, `${JSON.stringify(fresh, null, 1)}\n`)
    expect(fresh).toEqual(process.env.UPDATE_NOTIFY_CASES === '1' ? fresh : table)
  })
})
