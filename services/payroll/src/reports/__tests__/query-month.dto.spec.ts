import 'reflect-metadata'
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common'
import { QueryComparisonDto, QuerySummaryDto } from '../dto/query-report.dto'
import { BulkExcelPayslipsDto } from '../../payslips/dto/bulk-excel-payslips.dto'

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
const meta = (metatype: unknown): ArgumentMetadata => ({ type: 'query', metatype }) as ArgumentMetadata

describe('month query bắt buộc: thiếu/sai định dạng → 400 (không để Prisma bỏ filter)', () => {
  it.each([
    ['QuerySummaryDto', QuerySummaryDto],
    ['BulkExcelPayslipsDto', BulkExcelPayslipsDto],
  ])('%s từ chối thiếu month hoặc month sai', async (_n, dto) => {
    await expect(pipe.transform({}, meta(dto))).rejects.toBeInstanceOf(BadRequestException)
    await expect(pipe.transform({ month: '2026-13' }, meta(dto))).rejects.toBeInstanceOf(BadRequestException)
    await expect(pipe.transform({ month: '2026-03' }, meta(dto))).resolves.toMatchObject({ month: '2026-03' })
  })

  it('QueryComparisonDto: thiếu months, phần tử sai hoặc quá 24 tháng → 400', async () => {
    await expect(pipe.transform({}, meta(QueryComparisonDto))).rejects.toBeInstanceOf(BadRequestException)
    await expect(pipe.transform({ months: '2026-01,abc' }, meta(QueryComparisonDto))).rejects.toBeInstanceOf(BadRequestException)
    const many = Array.from({ length: 25 }, (_, i) => `2024-${String((i % 12) + 1).padStart(2, '0')}`).join(',')
    await expect(pipe.transform({ months: many }, meta(QueryComparisonDto))).rejects.toBeInstanceOf(BadRequestException)
    await expect(pipe.transform({ months: '2026-01, 2026-02' }, meta(QueryComparisonDto))).resolves.toBeDefined()
  })
})
