import 'reflect-metadata';
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { UpdateJobTitleDto } from '../dto/update-job-title.dto';
import { UpdateKanbanLabelDto } from '../../kanban/boards/dto/update-label.dto';
import { UpdateKanbanFieldDefDto } from '../../kanban/field-defs/dto/update-field-def.dto';
import { UpdateContactDto } from '../../contacts/dto/update-contact.dto';

// Cấu hình y hệt main.ts. Lỗi cũ: PartialType/@IsOptional để `null` lọt rồi `.trim()` ném TypeError (500) hoặc ghi null vào cột NOT NULL.
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const meta = (metatype: unknown): ArgumentMetadata => ({ type: 'body', metatype }) as ArgumentMetadata;

describe('Update DTO — null vào field NOT NULL phải 400', () => {
  it.each([
    ['label.name', UpdateKanbanLabelDto, { name: null }],
    ['label.color', UpdateKanbanLabelDto, { color: null }],
    ['job-title.name', UpdateJobTitleDto, { name: null }],
    ['job-title.is_active', UpdateJobTitleDto, { is_active: null }],
    ['job-title.sort_order', UpdateJobTitleDto, { sort_order: null }],
    ['contact.full_name', UpdateContactDto, { full_name: null }],
    ['contact.source_id', UpdateContactDto, { source_id: null }],
    ['field-def.label', UpdateKanbanFieldDefDto, { label: null }],
  ])('%s = null → BadRequest', async (_n, cls, body) => {
    await expect(pipe.transform(body, meta(cls))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('job-title.default_insurance_salary = null vẫn được (xoá cấu hình)', async () => {
    const out = (await pipe.transform({ default_insurance_salary: null }, meta(UpdateJobTitleDto))) as UpdateJobTitleDto;
    expect(out.default_insurance_salary).toBeNull();
  });

  it('bỏ trống field (PATCH một phần) vẫn hợp lệ', async () => {
    await expect(pipe.transform({ name: 'Gấp' }, meta(UpdateKanbanLabelDto))).resolves.toBeDefined();
    await expect(pipe.transform({}, meta(UpdateJobTitleDto))).resolves.toBeDefined();
  });
});
