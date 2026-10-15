import { BadRequestException } from '@nestjs/common'
import { grantsToRows, parseGrantsInput } from './grants-input'

describe('parseGrantsInput', () => {
  it('quyền scoped + không scoped hợp lệ', () => {
    expect(parseGrantsInput({ 'contacts.view': 'team', 'roles.manage': null })).toEqual({
      'contacts.view': 'team',
      'roles.manage': true,
    })
  })

  it('khoá lạ → 400 (không bỏ lặng lẽ)', () => {
    expect(() => parseGrantsInput({ 'x.y': 'all' })).toThrow(BadRequestException)
    expect(() => parseGrantsInput(JSON.parse('{"__proto__":"all"}'))).toThrow(BadRequestException)
  })

  it('quyền scoped thiếu / sai scope → 400', () => {
    expect(() => parseGrantsInput({ 'contacts.view': null })).toThrow(BadRequestException)
    expect(() => parseGrantsInput({ 'contacts.view': 'everyone' })).toThrow(BadRequestException)
  })

  it('quyền không scoped kèm scope → 400', () => {
    expect(() => parseGrantsInput({ 'roles.manage': 'all' })).toThrow(BadRequestException)
  })

  it('false/undefined = không cấp', () => {
    expect(parseGrantsInput({ 'contacts.view': false, 'roles.manage': undefined })).toEqual({})
  })

  it('grantsToRows: scope NULL với quyền không scoped', () => {
    expect(grantsToRows(3, { 'contacts.view': 'own', 'roles.manage': true })).toEqual([
      { role_id: 3, permission: 'contacts.view', scope: 'own' },
      { role_id: 3, permission: 'roles.manage', scope: null },
    ])
  })
})
