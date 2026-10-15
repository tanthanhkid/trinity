import { BadRequestException } from '@nestjs/common';
import { maskPhone } from '@trinity/rbac-nest';
import { CreateContactDto } from '../../../contacts/dto/create-contact.dto';
import { UpdateContactDto } from '../../../contacts/dto/update-contact.dto';
import { optInt } from '../tools/tool-types';
import { NOTE_MAX, type ActionToolDef } from './action-types';
import { cleanText, compact, line, lines, loadContactForDraft, loadContactInScope, optionLabel, shown, validateDto } from './action-helpers';

const ID = (z: import('../tools/tool-types').Z) => z.number().int().min(1).max(2_147_483_647);
const str = (v: unknown, max: number): string | undefined => {
  const s = cleanText(v, max);
  return s === '' ? undefined : s;
};

export const createContactAction: ActionToolDef = {
  name: 'create_contact',
  label: 'Tạo khách hàng',
  title: 'Tạo khách hàng / Create a contact',
  description:
    'Tạo một khách hàng mới, chạy ngay theo quyền của bạn. Cần họ tên, SĐT (0xxxxxxxxx hoặc +84xxxxxxxxx) và source_id (lấy từ list_crm_options). ' +
    'Khách sẽ do chính bạn phụ trách. / Creates a new customer immediately within your permissions.',
  permissions: ['contacts.create'],
  destructive: false,
  idempotent: false,
  input: (z) => ({
    full_name: z.string().min(1).max(100).describe('Họ và tên khách / Full name'),
    phone: z.string().min(10).max(12).describe('SĐT dạng 0xxxxxxxxx hoặc +84xxxxxxxxx / Phone'),
    source_id: ID(z).describe('Nguồn khách (id từ list_crm_options) / Source id'),
    stage_id: ID(z).optional().describe('Giai đoạn (id từ list_crm_options), mặc định "Mới" / Stage id'),
    job_title: z.string().max(100).optional().describe('Nghề nghiệp / Job title'),
    company_name: z.string().max(150).optional().describe('Công ty / Company'),
    email: z.string().max(150).optional().describe('Email'),
  }),
  async prepare(args, { deps }) {
    const params = compact({
      full_name: str(args.full_name, 100), phone: str(args.phone, 12), source_id: optInt(args.source_id), stage_id: optInt(args.stage_id),
      job_title: str(args.job_title, 100), company_name: str(args.company_name, 150), email: str(args.email, 150),
    });
    const dto = await validateDto(CreateContactDto, params);
    const source = await optionLabel(deps, dto.source_id, 'contact_source', 'source_id');
    const stage = dto.stage_id ? await optionLabel(deps, dto.stage_id, 'contact_stage', 'stage_id') : null;
    const phone = maskPhone(dto.phone) ?? '***';
    return {
      params,
      summary: shown(`Tạo khách hàng "${dto.full_name}" (SĐT ${phone}), nguồn: ${source}${stage ? `, giai đoạn: ${stage}` : ''}`),
      details: lines(line('Họ tên', dto.full_name), line('SĐT (đã che)', phone), line('Nguồn', source), line('Giai đoạn', stage ?? 'Mặc định (Mới)'), line('Nghề nghiệp', dto.job_title), line('Công ty', dto.company_name), line('Email', dto.email)),
    };
  },
  async execute(params, { deps, user }) {
    const dto = await validateDto(CreateContactDto, params);
    const res = await deps.contacts.create(dto, user);
    return { contact_id: res.contact.id };
  },
};

export const addNoteAction: ActionToolDef = {
  name: 'add_contact_note',
  label: 'Thêm ghi chú cho khách',
  title: 'Thêm ghi chú / Add a contact note',
  description:
    'Thêm một ghi chú vào lịch sử chăm sóc của khách (id số, trong phạm vi quyền sửa của bạn), ghi ngay. / Adds a note to a customer timeline immediately.',
  permissions: ['contacts.update'],
  destructive: false,
  idempotent: false,
  input: (z) => ({
    contact_id: ID(z).describe('ID khách hàng / Contact id'),
    note: z.string().min(1).max(NOTE_MAX).describe(`Nội dung ghi chú, tối đa ${NOTE_MAX} ký tự / Note text`),
  }),
  async prepare(args, { deps, user }) {
    const id = optInt(args.contact_id);
    const note = cleanText(args.note, NOTE_MAX);
    if (!id) throw new BadRequestException('contact_id phải là số nguyên dương');
    if (!note) throw new BadRequestException('Nội dung ghi chú không được rỗng');
    const c = await loadContactForDraft(deps, user, id, 'contacts.update');
    return {
      params: { contact_id: id, note },
      summary: shown(`Thêm ghi chú vào khách "${c.full_name ?? `#${c.id}`}": "${note.replace(/\s+/g, ' ')}"`, 300),
      details: lines(line('Khách hàng', `${c.full_name ?? '(chưa có tên)'} (#${c.id})`), line('Nội dung ghi chú', note, NOTE_MAX)),
    };
  },
  async execute(params, { deps, user }, draftId) {
    const id = optInt(params.contact_id);
    const note = cleanText(params.note, NOTE_MAX);
    if (!id || !note) throw new BadRequestException('Dữ liệu đề xuất không hợp lệ');
    await loadContactInScope(deps, user, id, 'contacts.update');
    const act = await deps.activities.create({ contactId: id, action: 'note', details: { description: note, source: 'ai_action' }, metadata: { ai_action_draft_id: draftId }, createdBy: user.userId });
    // Thẻ @ trong ghi chú → "Được nhắc tới ở" của bản ghi được nhắc (theo quyền xem của người duyệt).
    await deps.links.syncMentions({ type: 'contact', id }, `note:${act.id}`, note, user);
    return { contact_id: id, activity_id: act.id };
  },
};

export const updateStageAction: ActionToolDef = {
  name: 'update_contact_stage',
  label: 'Đổi giai đoạn khách',
  title: 'Đổi giai đoạn / Change stage',
  description:
    'Chuyển khách (id số, trong phạm vi quyền sửa của bạn) sang giai đoạn khác (stage_id từ list_crm_options), có hiệu lực ngay. / Moves a customer to another stage immediately.',
  permissions: ['contacts.update'],
  destructive: true,
  idempotent: true,
  input: (z) => ({
    contact_id: ID(z).describe('ID khách hàng / Contact id'),
    stage_id: ID(z).describe('Giai đoạn mới (id từ list_crm_options) / New stage id'),
  }),
  async prepare(args, { deps, user }) {
    const id = optInt(args.contact_id);
    const stageId = optInt(args.stage_id);
    if (!id || !stageId) throw new BadRequestException('contact_id và stage_id phải là số nguyên dương');
    const dto = await validateDto(UpdateContactDto, { stage_id: stageId });
    const c = await loadContactForDraft(deps, user, id, 'contacts.update');
    const to = await optionLabel(deps, stageId, 'contact_stage', 'stage_id');
    if (c.stage_id === stageId) throw new BadRequestException(`Khách đã ở giai đoạn "${to}"`);
    const from = c.stage?.label ?? '(chưa có)';
    return {
      params: { contact_id: id, stage_id: dto.stage_id },
      summary: shown(`Đổi giai đoạn khách "${c.full_name ?? `#${c.id}`}": ${from} → ${to}`),
      details: lines(line('Khách hàng', `${c.full_name ?? '(chưa có tên)'} (#${c.id})`), line('Giai đoạn hiện tại', from), line('Giai đoạn mới', to)),
    };
  },
  async execute(params, { deps, user }) {
    const id = optInt(params.contact_id);
    const dto = await validateDto(UpdateContactDto, { stage_id: params.stage_id as number });
    if (!id) throw new BadRequestException('Dữ liệu đề xuất không hợp lệ');
    await deps.contacts.update(id, dto, user);
    return { contact_id: id, stage_id: dto.stage_id ?? null };
  },
};

export const assignContactAction: ActionToolDef = {
  name: 'assign_contact',
  label: 'Chuyển người phụ trách',
  title: 'Chuyển khách cho người khác / Reassign a contact',
  description:
    'Chuyển người phụ trách của khách (id số) cho một nhân viên khác trong phạm vi quyền chuyển khách của bạn (user id từ list_crm_options), có hiệu lực ngay. / Reassigns a customer immediately within your permissions.',
  permissions: ['contacts.transfer'],
  destructive: true,
  idempotent: true,
  input: (z) => ({
    contact_id: ID(z).describe('ID khách hàng / Contact id'),
    new_assigned_to: ID(z).describe('User id người nhận (từ list_crm_options) / New owner user id'),
    reason: z.string().max(200).optional().describe('Lý do (tuỳ chọn) / Reason'),
  }),
  async prepare(args, { deps, user }) {
    const id = optInt(args.contact_id);
    const to = optInt(args.new_assigned_to);
    if (!id || !to) throw new BadRequestException('contact_id và new_assigned_to phải là số nguyên dương');
    const c = await loadContactForDraft(deps, user, id, 'contacts.transfer');
    if (c.assigned_to === to) throw new BadRequestException('Người này đang là người phụ trách hiện tại');
    // Người nhận PHẢI nằm trong phạm vi `contacts.transfer` của người dùng và đang hoạt động — AI không chọn được ai tuỳ ý.
    const allowed = await deps.scope.ownerIds(user, 'contacts.transfer');
    const target = await deps.prisma.user.findFirst({ where: { id: to, status: 'active', deleted_at: null }, select: { id: true, full_name: true } });
    if (!target || (allowed !== 'all' && !(allowed ?? []).includes(to))) {
      throw new BadRequestException('Người nhận không hợp lệ hoặc nằm ngoài phạm vi chuyển khách của bạn (xem list_crm_options)');
    }
    const reason = str(args.reason, 200);
    return {
      params: compact({ contact_id: id, new_assigned_to: to, reason }),
      summary: shown(`Chuyển khách "${c.full_name ?? `#${c.id}`}" cho ${target.full_name}`),
      details: lines(line('Khách hàng', `${c.full_name ?? '(chưa có tên)'} (#${c.id})`), line('Người nhận', target.full_name), line('Lý do', reason)),
    };
  },
  async execute(params, { deps, user }) {
    const id = optInt(params.contact_id);
    const to = optInt(params.new_assigned_to);
    if (!id || !to) throw new BadRequestException('Dữ liệu đề xuất không hợp lệ');
    const reason = `Do AI thực hiện${params.reason ? `: ${cleanText(params.reason, 200)}` : ''}`;
    const res = await deps.transfer.transfer(id, to, reason, user);
    return { contact_id: res.contactId, from_user_id: res.fromUserId, to_user_id: res.toUserId };
  },
};
