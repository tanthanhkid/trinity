/**
 * Golden kiểm dữ liệu vào của M06 cho bản Rust (`server/crates/mod-settings`): chạy các payload thử qua `ValidationPipe` thật
 * (strict, như `ServiceAwareValidationPipe` của route `settings/*`) cho 4 DTO chưa có trong `server/contracts/dto/schema.json`.
 * Sinh lại: `UPDATE_GOLDEN=1 pnpm --filter @trinity/monolith exec jest src/__tests__/settings-dto-golden`.
 */
import 'reflect-metadata'
import * as fs from 'fs'
import * as path from 'path'
import { BadRequestException, ValidationPipe } from '@nestjs/common'

import { UpdateOptionDto } from '../../../../services/crm/src/settings-options/dto/update-option.dto'
import { UpdateNotificationSoundDto } from '../../../../services/crm/src/settings/dto/notification-sound.dto'
import { UpdateDepartmentsDto } from '../../../../services/crm/src/settings/dto/departments.dto'
import { UpdateOrgFeaturesDto } from '../../../../services/crm/src/settings/dto/org-features.dto'

const FILE = path.resolve(__dirname, '../../../../server/crates/mod-settings/tests/fixtures/dto.json')
const long = (n: number) => 'x'.repeat(n)

const CASES: Array<[string, new () => object, unknown[]]> = [
  ['UpdateOptionDto', UpdateOptionDto, [
    {}, { label: 'Nhãn mới' }, { label: long(100) }, { label: long(101) }, { label: 5 }, { label: null }, { label: '😀'.repeat(60) },
    { sort_order: 0 }, { sort_order: 7 }, { sort_order: -1 }, { sort_order: 1.5 }, { sort_order: '3' }, { sort_order: null }, { sort_order: true },
    { is_active: false }, { is_active: 'yes' }, { is_active: null }, { is_active: 0 },
    { metadata: { a: 1 } }, { metadata: null }, { metadata: [] }, { metadata: 'x' }, { metadata: 5 },
    { label: 'a', sort_order: 2, is_active: true, metadata: { k: 'v' } }, { label: 1, sort_order: 'x', is_active: 'y', metadata: 3 },
    { group_key: 'doi' }, { value: 'doi', label: 'a' }, { hack: 1, extra: 2 }, { label: 'a', hack: 1 },
    [], 'chuoi', 5, null,
  ]],
  ['UpdateNotificationSoundDto', UpdateNotificationSoundDto, [
    {}, { sound_id: 'beep' }, { sound_id: 'power-up' }, { sound_id: 'khong-co' }, { sound_id: '' }, { sound_id: 5 }, { sound_id: null }, { sound_id: ['beep'] },
    { sound_id: 'beep', hack: 1 }, { hack: 1 }, [], 'x',
  ]],
  ['UpdateDepartmentsDto', UpdateDepartmentsDto, [
    {}, { departments: ['A'] }, { departments: [] }, { departments: ['A', 'B', 'C'] }, { departments: [long(100)] }, { departments: [long(101)] },
    { departments: ['A', 5] }, { departments: [null] }, { departments: Array.from({ length: 50 }, (_, i) => `P${i}`) },
    { departments: Array.from({ length: 51 }, (_, i) => `P${i}`) }, { departments: 'A' }, { departments: long(101) }, { departments: 5 }, { departments: null },
    { departments: { a: 1 } }, { departments: ['  ', 'a'] }, { departments: ['A'], hack: 1 }, { hack: 1 }, [], 'x',
  ]],
  ['UpdateOrgFeaturesDto', UpdateOrgFeaturesDto, [
    {}, { kanban: false }, { kanban: true, pos: false }, { kanban: 'no' }, { kanban: null }, { kanban: 0 }, { dashboard: 1, contacts: 'x', reports: [] },
    { google_sheets: true }, { commerce_connectors: false }, { payments: true }, { hack: true }, { kanban: false, hack: true, other: 1 },
    { ai_briefing: true, zalo_oa: true, lead_scoring: true, stale_reminders: true, facebook_page: true, online_store: true, inbox: false, social_posting: false },
    [], 'x', null,
  ]],
]

async function run(cls: new () => object, payload: unknown): Promise<unknown> {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
  try {
    const out = await pipe.transform(JSON.parse(JSON.stringify(payload)), { type: 'body', metatype: cls, data: '' })
    return { ok: JSON.parse(JSON.stringify(out)) }
  } catch (e) {
    if (!(e instanceof BadRequestException)) throw e
    return { status: 400, message: (e.getResponse() as { message: unknown }).message }
  }
}

describe('settings DTO golden', () => {
  it('ValidationPipe thật cho 4 DTO của M06', async () => {
    const out: Array<{ dto: string; payload: unknown; result: unknown }> = []
    for (const [dto, cls, payloads] of CASES) for (const payload of payloads) out.push({ dto, payload, result: await run(cls, payload) })
    const text = `${JSON.stringify(out, null, 1)}\n`
    if (process.env.UPDATE_GOLDEN === '1') {
      fs.mkdirSync(path.dirname(FILE), { recursive: true })
      fs.writeFileSync(FILE, text)
    }
    expect(fs.readFileSync(FILE, 'utf8')).toBe(text)
  })
})
