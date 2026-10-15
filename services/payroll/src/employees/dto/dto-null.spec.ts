import 'reflect-metadata'
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common'
import { UpdateEmployeeDto } from './update-employee.dto'
import { CreateEmployeeDto } from './create-employee.dto'
import { UpdateSalaryRuleDto } from '../../salary-rules/dto/update-rule.dto'
import { UpdateSalaryComponentDto } from '../../salary-components/dto/salary-component.dto'
import { UpdateInsuranceSettingDto } from '../../insurance/dto/insurance-setting.dto'
import { UpdateTaxBracketDto, UpdateTaxSettingDto } from '../../tax/dto/tax-config.dto'

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
const meta = (metatype: unknown): ArgumentMetadata => ({ type: 'body', metatype }) as ArgumentMetadata

describe('payroll DTO: null trên cột NOT NULL → 400; vị trí phải thuộc danh sách', () => {
  it.each([
    ['UpdateEmployeeDto', UpdateEmployeeDto, { position: null }],
    ['UpdateEmployeeDto', UpdateEmployeeDto, { status: null }],
    ['UpdateSalaryRuleDto', UpdateSalaryRuleDto, { position: null }],
    ['UpdateSalaryRuleDto', UpdateSalaryRuleDto, { name: null }],
    ['UpdateSalaryComponentDto', UpdateSalaryComponentDto, { name: null }],
    ['UpdateSalaryComponentDto', UpdateSalaryComponentDto, { is_active: null }],
    ['UpdateSalaryComponentDto', UpdateSalaryComponentDto, { sort_order: null }],
    ['UpdateInsuranceSettingDto', UpdateInsuranceSettingDto, { is_active: null }],
    ['UpdateInsuranceSettingDto', UpdateInsuranceSettingDto, { name: null }],
    ['UpdateTaxBracketDto', UpdateTaxBracketDto, { rate: null }],
    ['UpdateTaxSettingDto', UpdateTaxSettingDto, { personal_deduction: null }],
    ['UpdateTaxSettingDto', UpdateTaxSettingDto, { is_active: null }],
  ])('%s %j', async (_n, dto, body) => {
    await expect(pipe.transform(body, meta(dto))).rejects.toBeInstanceOf(BadRequestException)
  })

  it('cột nullable vẫn nhận null (upper_bound, effective_to)', async () => {
    await expect(pipe.transform({ upper_bound: null }, meta(UpdateTaxBracketDto))).resolves.toMatchObject({ upper_bound: null })
    await expect(pipe.transform({ effective_to: null }, meta(UpdateTaxSettingDto))).resolves.toMatchObject({ effective_to: null })
  })

  it('position lạ bị từ chối ở create và update, vị trí hợp lệ qua', async () => {
    await expect(pipe.transform({ position: 'salez' }, meta(UpdateEmployeeDto))).rejects.toBeInstanceOf(BadRequestException)
    await expect(pipe.transform({ position: 'hr' }, meta(UpdateEmployeeDto))).resolves.toMatchObject({ position: 'hr' })
    const base = { user_id: 1, salary_rule_id: 1, joined_at: '2026-01-15' }
    await expect(pipe.transform({ ...base, position: 'salez' }, meta(CreateEmployeeDto))).rejects.toBeInstanceOf(BadRequestException)
  })
})
