import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
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

  it('reject vượt trần MAX_PINNED_MENU_KEYS', async () => {
    const keys = KNOWN_MENU_KEYS.slice(0, MAX_PINNED_MENU_KEYS + 1) as unknown as string[]
    const errors = await validateDto({ keys })
    const err = errors.find((e) => e.property === 'keys')
    expect(err).toBeDefined()
  })

  it('reject khi keys KHÔNG phải mảng', async () => {
    const errors = await validateDto({ keys: 'contacts' })
    const err = errors.find((e) => e.property === 'keys')
    expect(err).toBeDefined()
  })
})
