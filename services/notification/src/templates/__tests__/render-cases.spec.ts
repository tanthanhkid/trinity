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

type Render = { template: string; ok?: string; err?: string }
type Syntax = { template: string; ok: boolean; err?: string }
type Table = { _doc: string; data: Record<string, unknown>; render: Render[]; syntax: Syntax[] }

const first = (e: unknown) => String((e as Error).message).split('\n')[0]

describe('ca render và kiểm cú pháp mẫu thông báo (notify-templates.json)', () => {
  const table = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Table
  const fresh: Table = {
    ...table,
    render: table.render.map(({ template }) => {
      try {
        return { template, ok: Handlebars.compile(template, OPTS)(table.data) }
      } catch (e) {
        return { template, err: first(e) }
      }
    }),
    syntax: table.syntax.map(({ template }) => {
      try {
        Handlebars.precompile(template, OPTS)
        return { template, ok: true }
      } catch (e) {
        return { template, ok: false, err: first(e) }
      }
    }),
  }

  it('kết quả của handlebars.js khớp bảng', () => {
    if (process.env.UPDATE_NOTIFY_CASES === '1') fs.writeFileSync(FILE, `${JSON.stringify(fresh, null, 1)}\n`)
    expect(fresh).toEqual(process.env.UPDATE_NOTIFY_CASES === '1' ? fresh : table)
  })
})
