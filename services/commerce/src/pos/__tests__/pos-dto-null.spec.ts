import 'reflect-metadata';
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  CreateAreaDto, CreateModifierDto, CreateTableDto, UpdateAreaDto, UpdateModifierDto, UpdateSettingsDto, UpdateTableDto,
} from '../dto/shift-catalog.dto';
import { UpdateOrderDto } from '../dto/order.dto';

/**
 * `@IsOptional()` bỏ qua cả `null`: `{ store_name: null }` lọt tới Prisma trên cột NOT NULL ⇒ 500.
 * Các field NOT NULL dùng `ValidateIf(v !== undefined)` ⇒ `null` bị 400 ngay ở pipe; field nullable vẫn nhận `null` (xoá giá trị).
 */
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const meta = (metatype: unknown): ArgumentMetadata => ({ type: 'body', metatype }) as ArgumentMetadata;

const NOT_NULL: Array<[string, unknown, Record<string, unknown>]> = [
  ['UpdateSettingsDto.store_name', UpdateSettingsDto, { store_name: null }],
  ['UpdateAreaDto.name', UpdateAreaDto, { name: null }],
  ['UpdateAreaDto.sort_order', UpdateAreaDto, { sort_order: null }],
  ['UpdateAreaDto.is_active', UpdateAreaDto, { is_active: null }],
  ['UpdateTableDto.name', UpdateTableDto, { name: null }],
  ['UpdateTableDto.sort_order', UpdateTableDto, { sort_order: null }],
  ['UpdateTableDto.is_active', UpdateTableDto, { is_active: null }],
  ['UpdateModifierDto.group_name', UpdateModifierDto, { group_name: null }],
  ['UpdateModifierDto.name', UpdateModifierDto, { name: null }],
  ['UpdateModifierDto.sort_order', UpdateModifierDto, { sort_order: null }],
  ['UpdateModifierDto.is_active', UpdateModifierDto, { is_active: null }],
  ['CreateAreaDto.sort_order', CreateAreaDto, { name: 'A', sort_order: null }],
  ['CreateTableDto.sort_order', CreateTableDto, { area_id: 1, name: 'T', sort_order: null }],
  ['CreateModifierDto.sort_order', CreateModifierDto, { group_name: 'G', name: 'N', sort_order: null }],
  ['UpdateOrderDto.discount_value', UpdateOrderDto, { discount_value: null }],
  ['UpdateOrderDto.items', UpdateOrderDto, { items: null }],
];

describe('POS DTO: null trên cột NOT NULL → 400, không lọt xuống Prisma', () => {
  it.each(NOT_NULL)('%s', async (_n, dto, body) => {
    await expect(pipe.transform(body, meta(dto))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('field nullable vẫn nhận null (xoá giá trị) và bỏ qua field không gửi', async () => {
    await expect(pipe.transform({ address: null, phone: null, bank_bin: null }, meta(UpdateSettingsDto))).resolves.toMatchObject({ address: null });
    await expect(pipe.transform({}, meta(UpdateAreaDto))).resolves.toEqual({});
    await expect(pipe.transform({ name: 'Tầng 1', sort_order: 2 }, meta(UpdateAreaDto))).resolves.toMatchObject({ name: 'Tầng 1', sort_order: 2 });
  });
});
