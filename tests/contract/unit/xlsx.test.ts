import { crc32, deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { readXlsx } from '../lib/xlsx.js'

/** Dựng .xlsx tối thiểu bằng tay (zip có nén + không nén) để kiểm bộ đọc ô không cần thư viện. */
function zip(files: Record<string, string>): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text)
    const deflate = name.endsWith('sheet1.xml')
    const data = deflate ? deflateRawSync(raw) : raw
    const nm = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(deflate ? 8 : 0, 8)
    local.writeUInt32LE(crc32(raw), 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nm.length, 26)
    parts.push(local, nm, data)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(deflate ? 8 : 0, 10)
    c.writeUInt32LE(crc32(raw), 16)
    c.writeUInt32LE(data.length, 20)
    c.writeUInt32LE(raw.length, 24)
    c.writeUInt16LE(nm.length, 28)
    c.writeUInt32LE(offset, 42)
    central.push(c, nm)
    offset += 30 + nm.length + data.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cd, end])
}

describe('đọc xlsx theo ô', () => {
  it('chuỗi dùng chung, chuỗi nội tuyến, số, ô trống, ký tự thoát XML, bảng đã nén', () => {
    const buf = zip({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Nhân &amp; viên" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>Họ tên</t></si><si><r><t>Nguyễn </t></r><r><t>A &lt;1&gt;</t></r></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>x</t></is></c></row>' +
        '<row r="3"><c r="B3" t="s"><v>1</v></c><c r="C3"><v>42.5</v></c></row><row r="4"/></sheetData></worksheet>',
    })
    expect(readXlsx(buf)).toEqual([
      {
        name: 'Nhân & viên',
        rows: [['Họ tên', '', 'x'], [], ['', 'Nguyễn A <1>', '42.5']],
      },
    ])
  })

  it('không phải zip ⇒ lỗi rõ ràng', () => {
    expect(() => readXlsx(Buffer.from('không phải xlsx'))).toThrow(/zip/)
  })
})
