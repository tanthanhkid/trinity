import { IsString } from 'class-validator';
import { renamed, viValidation } from '../action-helpers';
import { errText } from '../import-custom';
import { BadRequestException } from '@nestjs/common';
import type { AiActionDraft } from '@prisma/client';
import { CreateContactDto } from '../../../../contacts/dto/create-contact.dto';
import { EXTENSION_TOOLS } from '../../tools/extension-tools';
import { MCP_TOOLS } from '../../mcp-tools.registry';
import { loadMcpSdk } from '../../mcp-sdk';
import { ACTION_TOOLS } from '../action-registry';
import { cleanText, compact, line, shown, validateDto } from '../action-helpers';
import { effectiveStatus, toView } from '../ai-action-view';
import { DRAFTS_PER_MINUTE, DRAFT_TTL_MS, MAX_PENDING_DRAFTS } from '../action-types';

const row = (o: Partial<AiActionDraft> = {}): AiActionDraft => ({
  id: 7, user_id: 1, client_id: 'c', tool: 'create_contact', params: { phone: '0987654321', full_name: 'A' }, summary: 'Tạo khách "A" (SĐT ***321)',
  details: [{ label: 'Họ tên', value: 'A' }, { label: 'x', value: 5 }, null], status: 'pending', result: null, error: null,
  created_at: new Date(), decided_at: null, expires_at: new Date(Date.now() + 1000), ...o,
}) as unknown as AiActionDraft;

describe('registry đề xuất', () => {
  const { z } = loadMcpSdk();
  it('chỉ đúng danh sách thao tác ghi (lõi + create_record/update_record + archive_record + tool cấu trúc), KHÔNG có xoá/xuất/quản trị/duyệt; mỗi tool ghi có scope crm.write + readOnlyHint:false', () => {
    expect(ACTION_TOOLS.map((t) => t.name).sort()).toEqual(['add_contact_note', 'add_field', 'archive_field', 'archive_record', 'assign_contact', 'create_contact', 'create_object', 'create_objects', 'create_record', 'create_recurring_post', 'create_social_post', 'create_task', 'create_view', 'import_records', 'import_social_posts', 'install_object_template', 'link_records', 'propose_workspace', 'publish_social_draft', 'reschedule_social_post', 'restore_structure_version', 'retry_social_post_target', 'set_menu', 'set_recurring_post_active', 'update_contact_stage', 'update_field', 'update_object', 'update_record', 'update_recurring_post', 'update_scheduled_post', 'update_view']);
    expect(MCP_TOOLS.map((t) => t.name).filter((n) => /delete|remove|export|download|role|user_|password|approve|reject/i.test(n))).toEqual([]);
    for (const a of ACTION_TOOLS) {
      const t = MCP_TOOLS.find((x) => x.name === a.name)!;
      expect(t.scope).toBe('crm.write');
      expect(t.annotations?.readOnlyHint).toBe(false);
      // create_record/update_record kiểm quyền THEO BẢNG bên trong prepare/execute (bảng lõi vs tuỳ biến) nên permissions cấp tool rỗng.
      if (!['create_record', 'update_record'].includes(a.name)) expect(t.permissions.length).toBeGreaterThan(0);
      expect(t.description).toContain('crm.write');
    }
    // Ngoại lệ ghi thẳng (không đụng dữ liệu nghiệp vụ) thay cho AI trên máy chủ: bản tin của chính người dùng + điểm ý định lead.
    const DIRECT_WRITES = ['set_features', 'save_crm_option', 'update_message_flow', 'create_comment_rule', 'update_comment_rule', 'update_messenger_broadcast', 'reply_to_google_review', 'cancel_scheduled_post', 'cancel_messenger_broadcast', 'save_briefing', 'set_lead_intent', 'complete_setup', 'upload_social_media', 'refresh_social_post_metrics', 'save_social_draft', 'set_queue_slots', 'save_social_snippet', 'enable_social_account', 'create_chat_link', 'create_message_flow', 'send_messenger_broadcast', 'reply_to_customer', 'create_payment_request', ...EXTENSION_TOOLS.filter((x) => x.scope).map((x) => x.name)]; // + tool chương trình con (nháp/chạy thử/deploy đã duyệt — không đụng dữ liệu khách) // complete_setup chỉ lật trạng thái dựng; upload_social_media chỉ thêm tệp vào thư viện, chưa đăng gì
    for (const t of MCP_TOOLS.filter((x) => !ACTION_TOOLS.some((a) => a.name === x.name))) {
      expect(t.scope).toBe(DIRECT_WRITES.includes(t.name) ? 'crm.write' : undefined);
    }
  });
  it('quyền nghiệp vụ đúng với thiết kế + destructiveHint đúng', () => {
    const by = (n: string) => MCP_TOOLS.find((t) => t.name === n)!;
    expect(by('create_contact').permissions).toEqual(['contacts.create']);
    expect(by('add_contact_note').permissions).toEqual(['contacts.update']);
    expect(by('update_contact_stage').permissions).toEqual(['contacts.update']);
    expect(by('create_task').permissions).toEqual(['kanban.manage']);
    expect(by('assign_contact').permissions).toEqual(['contacts.transfer']);
    expect(by('create_contact').annotations?.destructiveHint).toBe(false);
    expect(by('update_contact_stage').annotations?.destructiveHint).toBe(true);
    expect(by('assign_contact').annotations?.destructiveHint).toBe(true);
  });
  it('create_task: người phụ trách chỉ nhận tên/email (không nhận id thô — máy chủ tự tìm trong phạm vi quyền); input giới hạn độ dài', () => {
    const t = z.object(MCP_TOOLS.find((x) => x.name === 'create_task')!.input(z));
    expect(Object.keys(t.shape)).not.toEqual(expect.arrayContaining(['assignee_id']));
    expect(Object.keys(t.shape).filter((k) => /assign/.test(k))).toEqual(['assignee']);
    expect(t.safeParse({ title: 'x', assignee: 'a'.repeat(201) }).success).toBe(false);
    const n = z.object(MCP_TOOLS.find((x) => x.name === 'add_contact_note')!.input(z));
    expect(n.safeParse({ contact_id: 1, note: 'x'.repeat(2001) }).success).toBe(false);
    expect(n.safeParse({ contact_id: 1, note: '' }).success).toBe(false);
  });
  it('hằng giới hạn', () => {
    expect([MAX_PENDING_DRAFTS, DRAFTS_PER_MINUTE, DRAFT_TTL_MS]).toEqual([50, 10, 24 * 3600 * 1000]);
  });
});

describe('view đề xuất', () => {
  it('KHÔNG BAO GIỜ trả params thô; chỉ giữ dòng chi tiết đúng dạng; pending quá hạn ⇒ expired', () => {
    const v = toView(row(), 'ChatGPT');
    expect(v).not.toHaveProperty('params');
    expect(JSON.stringify(v)).not.toContain('0987654321');
    expect(v.details).toEqual([{ label: 'Họ tên', value: 'A' }]);
    expect(v.tool_label).toBe('Tạo khách hàng');
    expect(effectiveStatus(row({ expires_at: new Date(Date.now() - 1) }))).toBe('expired');
    expect(effectiveStatus(row({ status: 'approved', expires_at: new Date(Date.now() - 1) }))).toBe('approved');
  });
  it('approved chưa có result: trong 5 phút = executing, quá 5 phút = failed (kết quả không rõ); có result = approved', () => {
    const base = { status: 'approved', expires_at: new Date(Date.now() - 1) } as const;
    expect(effectiveStatus(row({ ...base, decided_at: new Date(Date.now() - 60_000) }))).toBe('executing');
    expect(effectiveStatus(row({ ...base, decided_at: new Date(Date.now() - 6 * 60_000) }))).toBe('failed');
    expect(effectiveStatus(row({ ...base, decided_at: new Date(Date.now() - 6 * 60_000), result: { contact_id: 1 } as never }))).toBe('approved');
    expect(toView(row({ ...base, decided_at: new Date(Date.now() - 6 * 60_000) }), null).error).toContain('Không rõ kết quả');
  });
  it('lỗi hiển thị cũng che SĐT', () => {
    expect(toView(row({ status: 'failed', error: 'SĐT 0987654321 đã tồn tại' }), null).error).toBe('SĐT ***321 đã tồn tại');
  });
});

describe('helper tham số', () => {
  it('cleanText bỏ ký tự điều khiển/vô hình, chuẩn hoá xuống dòng, cắt độ dài; HTML giữ nguyên là văn bản thuần', () => {
    expect(cleanText('  a\u0000b​c\r\nd  ', 50)).toBe('abc\nd');
    expect(cleanText('x'.repeat(10), 3)).toBe('xxx');
    expect(cleanText('<script>alert(1)</script>', 100)).toBe('<script>alert(1)</script>');
    expect(cleanText(undefined, 10)).toBe('');
    expect(cleanText('abc\u202edef\u2066x\u2069', 50)).toBe('abcdefx'); // bidi override/isolate không đảo được thứ tự hiển thị
  });
  it('shown che SĐT; line bỏ giá trị rỗng; compact bỏ khoá rỗng', () => {
    expect(shown('gọi 0912345678 nhé')).toBe('gọi ***678 nhé');
    expect(line('a', '')).toBeNull();
    expect(line('SĐT', '0912 345 678')?.value).toBe('***678');
    expect(compact({ a: 1, b: undefined, c: null, d: '', e: 0 })).toEqual({ a: 1, e: 0 });
  });
  it('validateDto dùng đúng DTO nghiệp vụ: SĐT sai, thiếu trường, trường lạ (vd cccd/assigned_to AI cố nhét) đều bị từ chối', async () => {
    await expect(validateDto(CreateContactDto, { full_name: 'A', phone: '123', source_id: 1 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(validateDto(CreateContactDto, { phone: '0987654321', source_id: 1 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(validateDto(CreateContactDto, { full_name: 'A', phone: '0987654321', source_id: 1, assigned_to: 9 })).rejects.toBeInstanceOf(BadRequestException);
    const ok = await validateDto(CreateContactDto, { full_name: 'A', phone: '0987654321', source_id: 1 });
    expect(ok.full_name).toBe('A');
  });
});

describe('renamed() — summary sau khi sửa phản ánh giá trị mới', () => {
  it('đổi tên ⇒ "cũ → mới"; không đổi / không gửi ⇒ tên cũ; tên cũ trống ⇒ "(trống) → mới"', () => {
    expect(renamed('A', 'B')).toBe('A → B');
    expect(renamed('A', 'A')).toBe('A');
    expect(renamed('A', undefined)).toBe('A');
    expect(renamed(null, 'B')).toBe('(trống) → B');
    expect(renamed(null, undefined)).toBe('');
  });
});

describe('validateDto / errText: thông điệp class-validator tiếng Việt', () => {
  it('dịch các thông điệp mặc định phổ biến; thông điệp tự viết giữ nguyên', () => {
    expect(viValidation('property foo should not exist')).toBe('Trường không tồn tại: foo');
    expect(viValidation('full_name should not be empty')).toBe('full_name: bắt buộc');
    expect(viValidation('value must be a number conforming to the specified constraints')).toBe('value: phải là số');
    expect(viValidation('title must be a string')).toBe('title: phải là chuỗi');
    expect(viValidation('id must be an integer number')).toBe('id: phải là số nguyên');
    expect(viValidation('title must be shorter than or equal to 200 characters')).toBe('title: tối đa 200 ký tự');
    expect(viValidation('priority must be one of the following values: low, high')).toBe('priority: phải là một trong low, high');
    expect(viValidation('each value in tags must be a string')).toBe('tags (mỗi phần tử): phải là chuỗi');
    expect(viValidation('SĐT không hợp lệ')).toBe('SĐT không hợp lệ');
  });
  it('validateDto với trường lạ + sai kiểu ⇒ câu tiếng Việt ghép "; "', async () => {
    class Dto { @IsString() title!: string; }
    const err = await validateDto(Dto, { title: 5, foo: 1 }).catch((e: Error) => e);
    expect((err as Error).message).toContain('title: phải là chuỗi');
    expect((err as Error).message).toContain('Trường không tồn tại: foo');
    expect(errText(err)).toContain('Trường không tồn tại: foo');
    expect(errText(new BadRequestException(['property bar should not exist', 'x must be a string']))).toBe('Trường không tồn tại: bar; x: phải là chuỗi');
  });
});
