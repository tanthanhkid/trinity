import { describe, it, expect } from 'vitest'
import {
  birthdayIsoToDisplay,
  birthdayDisplayToIso,
  formatBirthdayInput,
} from '@/lib/birthday-format'

describe('birthdayIsoToDisplay', () => {
  it('converts ISO YYYY-MM-DD sang DD/MM/YYYY', () => {
    expect(birthdayIsoToDisplay('1990-03-15')).toBe('15/03/1990')
  })

  it('chấp nhận ISO có time suffix (slice 10 chars đầu)', () => {
    expect(birthdayIsoToDisplay('1990-03-15T00:00:00.000Z')).toBe('15/03/1990')
  })

  it('trả "" khi empty', () => {
    expect(birthdayIsoToDisplay('')).toBe('')
  })

  it('trả "" khi format sai', () => {
    expect(birthdayIsoToDisplay('15/03/1990')).toBe('')
    expect(birthdayIsoToDisplay('invalid')).toBe('')
  })
})

describe('birthdayDisplayToIso', () => {
  it('converts DD/MM/YYYY sang ISO YYYY-MM-DD', () => {
    expect(birthdayDisplayToIso('15/03/1990')).toBe('1990-03-15')
  })

  it('pad ngày và tháng 1 chữ số', () => {
    expect(birthdayDisplayToIso('1/3/1990')).toBe('1990-03-01')
    expect(birthdayDisplayToIso('5/12/2000')).toBe('2000-12-05')
  })

  it('reject ngày không tồn tại trong tháng (31/02)', () => {
    expect(birthdayDisplayToIso('31/02/1990')).toBe('')
    expect(birthdayDisplayToIso('31/04/1990')).toBe('')
    expect(birthdayDisplayToIso('31/11/2000')).toBe('')
  })

  it('reject Feb 29 năm không nhuận', () => {
    expect(birthdayDisplayToIso('29/02/2023')).toBe('')
    expect(birthdayDisplayToIso('29/02/2100')).toBe('')
  })

  it('chấp nhận Feb 29 năm nhuận', () => {
    expect(birthdayDisplayToIso('29/02/2000')).toBe('2000-02-29')
    expect(birthdayDisplayToIso('29/02/2024')).toBe('2024-02-29')
  })

  it('reject month > 12 hoặc < 1', () => {
    expect(birthdayDisplayToIso('15/13/1990')).toBe('')
    expect(birthdayDisplayToIso('15/00/1990')).toBe('')
  })

  it('reject day > 31 hoặc < 1', () => {
    expect(birthdayDisplayToIso('32/01/1990')).toBe('')
    expect(birthdayDisplayToIso('00/01/1990')).toBe('')
  })

  it('reject year ngoài 1900-2100', () => {
    expect(birthdayDisplayToIso('15/03/1899')).toBe('')
    expect(birthdayDisplayToIso('15/03/2101')).toBe('')
  })

  it('chấp nhận biên year 1900 và 2100', () => {
    expect(birthdayDisplayToIso('01/01/1900')).toBe('1900-01-01')
    expect(birthdayDisplayToIso('31/12/2100')).toBe('2100-12-31')
  })

  it('reject format sai (thiếu year, thiếu /)', () => {
    expect(birthdayDisplayToIso('15/03')).toBe('')
    expect(birthdayDisplayToIso('15-03-1990')).toBe('')
    expect(birthdayDisplayToIso('15.03.1990')).toBe('')
    expect(birthdayDisplayToIso('')).toBe('')
  })
})

describe('formatBirthdayInput', () => {
  it('tự chèn / sau ngày và tháng khi user gõ từng chữ số', () => {
    expect(formatBirthdayInput('1')).toBe('1')
    expect(formatBirthdayInput('15')).toBe('15')
    expect(formatBirthdayInput('153')).toBe('15/3')
    expect(formatBirthdayInput('1503')).toBe('15/03')
    expect(formatBirthdayInput('15031')).toBe('15/03/1')
    expect(formatBirthdayInput('15031990')).toBe('15/03/1990')
  })

  it('strip non-digit từ input', () => {
    expect(formatBirthdayInput('15/03/1990')).toBe('15/03/1990')
    expect(formatBirthdayInput('15-03-1990')).toBe('15/03/1990')
    expect(formatBirthdayInput('15.03.1990')).toBe('15/03/1990')
    expect(formatBirthdayInput('15 03 1990')).toBe('15/03/1990')
    expect(formatBirthdayInput('abc15def03ghi1990jkl')).toBe('15/03/1990')
  })

  it('giới hạn 8 chữ số (DDMMYYYY)', () => {
    expect(formatBirthdayInput('150319901234')).toBe('15/03/1990')
  })

  it('empty + chỉ separator', () => {
    expect(formatBirthdayInput('')).toBe('')
    expect(formatBirthdayInput('///')).toBe('')
    expect(formatBirthdayInput('...')).toBe('')
  })
})

describe('round-trip integration', () => {
  it('ISO → display → ISO giữ nguyên giá trị', () => {
    const iso = '1990-03-15'
    expect(birthdayDisplayToIso(birthdayIsoToDisplay(iso))).toBe(iso)
  })

  it('formatBirthdayInput output phải parse được khi đủ chữ số hợp lệ', () => {
    const formatted = formatBirthdayInput('15031990')
    expect(formatted).toBe('15/03/1990')
    expect(birthdayDisplayToIso(formatted)).toBe('1990-03-15')
  })
})
