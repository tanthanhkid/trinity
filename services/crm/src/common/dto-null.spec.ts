import 'reflect-metadata';
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { UpdateOfficeDto } from '../attendance/dto/office.dto';
import { UpdateContractDto } from '../contracts/dto/update-contract.dto';
import { UpdateCustomFieldDto } from '../custom-objects/dto/custom-field.dto';
import { UpdateCustomObjectDto } from '../custom-objects/dto/custom-object.dto';
import { UpdateDealDto } from '../deals/dto/update-deal.dto';
import { UpdateWebhookEndpointDto } from '../integrations/webhooks/dto/webhook-endpoint.dto';
import { UpdateKanbanChecklistItemDto } from '../kanban/checklist/dto/update-checklist-item.dto';
import { UpdateCandidateDto } from '../recruitment/dto/update-candidate.dto';
import { UpdatePositionDto } from '../recruitment/dto/update-position.dto';
import { UpdateOptionDto } from '../settings-options/dto/update-option.dto';
import { UpdateSyncDto } from '../google/dto/google-sync.dto';

/** `null` trên cột NOT NULL phải bị 400 ở pipe (không lọt xuống Prisma thành 500); cột nullable vẫn nhận `null` để xoá giá trị. */
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const meta = (metatype: unknown): ArgumentMetadata => ({ type: 'body', metatype }) as ArgumentMetadata;

const NOT_NULL: Array<[unknown, string]> = [
  [UpdateOfficeDto, 'name'], [UpdateOfficeDto, 'ips'], [UpdateOfficeDto, 'is_active'], [UpdateOfficeDto, 'is_demo'],
  [UpdateContractDto, 'contract_type'], [UpdateContractDto, 'signed_date'], [UpdateContractDto, 'is_terminated'],
  [UpdateCustomFieldDto, 'label'], [UpdateCustomFieldDto, 'type'], [UpdateCustomFieldDto, 'required'], [UpdateCustomFieldDto, 'options'],
  [UpdateCustomObjectDto, 'label'], [UpdateCustomObjectDto, 'label_plural'], [UpdateCustomObjectDto, 'show_in_nav'],
  [UpdateCustomObjectDto, 'nav_order'], [UpdateCustomObjectDto, 'visible_role_ids'], [UpdateCustomObjectDto, 'is_active'],
  [UpdateDealDto, 'title'], [UpdateDealDto, 'status'],
  [UpdateWebhookEndpointDto, 'name'], [UpdateWebhookEndpointDto, 'url'], [UpdateWebhookEndpointDto, 'events'], [UpdateWebhookEndpointDto, 'is_active'],
  [UpdateKanbanChecklistItemDto, 'text'], [UpdateKanbanChecklistItemDto, 'is_done'],
  [UpdateCandidateDto, 'full_name'], [UpdateCandidateDto, 'stage'], [UpdateCandidateDto, 'decision'], [UpdateCandidateDto, 'recruitment_type'],
  [UpdatePositionDto, 'job_code'], [UpdatePositionDto, 'department'], [UpdatePositionDto, 'position_title'], [UpdatePositionDto, 'headcount'], [UpdatePositionDto, 'status'],
  [UpdateOptionDto, 'label'], [UpdateOptionDto, 'sort_order'], [UpdateOptionDto, 'is_active'],
  [UpdateSyncDto, 'name'], [UpdateSyncDto, 'is_active'], [UpdateSyncDto, 'column_map'], [UpdateSyncDto, 'dedupe_key'],
];

describe('CRM update DTO: null trên cột NOT NULL → 400', () => {
  it.each(NOT_NULL.map(([d, f]) => [(d as { name: string }).name, f, d] as const))('%s.%s', async (_n, field, dto) => {
    await expect(pipe.transform({ [field]: null }, meta(dto))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('field nullable vẫn nhận null; body rỗng hợp lệ', async () => {
    await expect(pipe.transform({ end_date: null, notes: null, file_url: null }, meta(UpdateContractDto))).resolves.toMatchObject({ end_date: null });
    await expect(pipe.transform({ phone: null, note: null }, meta(UpdateCandidateDto))).resolves.toMatchObject({ phone: null });
    await expect(pipe.transform({ description: null, icon: null }, meta(UpdateCustomObjectDto))).resolves.toMatchObject({ icon: null });
    await expect(pipe.transform({}, meta(UpdateOfficeDto))).resolves.toEqual({});
  });
});
