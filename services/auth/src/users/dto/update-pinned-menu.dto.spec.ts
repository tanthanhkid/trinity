import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { readFileSync } from 'fs'
import { join } from 'path'
import { UpdatePinnedMenuDto } from './update-pinned-menu.dto'
import { KNOWN_MENU_KEYS, MAX_PINNED_MENU_KEYS } from '../pinned-menu.constants'

/**
 * chặn payload rác/quá khổ cho pin sidebar. BE KHÔNG kiểm role
 * được thấy key (đó là việc của FE `isItemVisible`/`isChildVisible`), chỉ
 * kiểm key có nằm trong `KNOWN_MENU_KEYS` không.
 */
describe('UpdatePinnedMenuDto validation', () => {
  async function validateDto(payload: Record<string, unknown>) {
    const dto = plainToInstance(UpdatePinnedMenuDto, payload)
    return validate(dto)
  }

  it('pass với mảng rỗng (user bỏ ghim hết)', async () => {
    const errors = await validateDto({ keys: [] })
    expect(errors).toHaveLength(0)
  })

  it('pass với key hợp lệ thuộc KNOWN_MENU_KEYS', async () => {
    const errors = await validateDto({ keys: ['contacts', 'kanban'] })
    expect(errors).toHaveLength(0)
  })

  it('reject key KHÔNG nằm trong KNOWN_MENU_KEYS', async () => {
    const errors = await validateDto({ keys: ['contacts', 'some-fake-key'] })
    const err = errors.find((e) => e.property === 'keys')
    expect(err).toBeDefined()
  })

  it('reject key trùng lặp (ArrayUnique)', async () => {
    const errors = await validateDto({ keys: ['contacts', 'contacts'] })
    const err = errors.find((e) => e.property === 'keys')
    expect(err).toBeDefined()
  })

  const customKeys = (n: number) => Array.from({ length: n }, (_, i) => `custom_bang_${i}`)

  it('trần ghim là 20 và bằng MAX_PINS ở FE', () => {
    expect(MAX_PINNED_MENU_KEYS).toBe(20)
    const hook = readFileSync(join(__dirname, '../../../../../apps/web/src/hooks/use-pinned-menus.ts'), 'utf8')
    expect(hook).toMatch(new RegExp(`export const MAX_PINS = ${MAX_PINNED_MENU_KEYS}\\b`))
  })

  it('pass đúng MAX_PINNED_MENU_KEYS (20) mục, kể cả trên 12', async () => {
    const errors = await validateDto({ keys: [...KNOWN_MENU_KEYS, ...customKeys(MAX_PINNED_MENU_KEYS - KNOWN_MENU_KEYS.length)] })
    expect(errors).toHaveLength(0)
  })

  it('reject vượt trần MAX_PINNED_MENU_KEYS', async () => {
    const keys = customKeys(MAX_PINNED_MENU_KEYS + 1)
    const errors = await validateDto({ keys })
    const err = errors.find((e) => e.property === 'keys')
    expect(err).toBeDefined()
  })

  it('reject khi keys KHÔNG phải mảng', async () => {
    const errors = await validateDto({ keys: 'contacts' })
    const err = errors.find((e) => e.property === 'keys')
    expect(err).toBeDefined()
  })

  it('pass với key bảng tuỳ biến custom_<key> và custom_<key>__<view>', async () => {
    const errors = await validateDto({ keys: ['contacts', 'custom_ghi_danh', 'custom_hoc_sinh__lop_a'] })
    expect(errors).toHaveLength(0)
  })

  it.each([
    'custom_',
    'custom_Ghi',
    'custom_1abc',
    'custom_a-b',
    'custom_a b',
    `custom_${'a'.repeat(98)}`,
    'custom_a\nb',
    'x:ghi_danh',
    '../etc/passwd',
    '',
  ])('reject key rác %j', async (bad) => {
    const errors = await validateDto({ keys: [bad] })
    expect(errors.find((e) => e.property === 'keys')).toBeDefined()
  })

  it('reject phần tử không phải chuỗi', async () => {
    const errors = await validateDto({ keys: [123, null] })
    expect(errors.find((e) => e.property === 'keys')).toBeDefined()
  })

  it('KNOWN_MENU_KEYS chứa mọi key menu của nav-config (ghim menu mới không bị 400)', () => {
    const nav = readFileSync(join(__dirname, '../../../../../apps/web/src/components/nav-config.ts'), 'utf8')
    const navKeys = [...nav.matchAll(/\bkey: *"([a-z0-9_-]+)"/g)].map((m) => m[1])
    expect(navKeys.length).toBeGreaterThan(10)
    expect(navKeys.filter((k) => !(KNOWN_MENU_KEYS as readonly string[]).includes(k))).toEqual([])
  })
})
