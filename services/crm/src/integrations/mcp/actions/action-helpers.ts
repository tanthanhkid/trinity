import { BadRequestException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { assertInScope, type AuthUser } from '@trinity/rbac-nest';
import type { Permission } from '@trinity/rbac';
import { maskPhonesInText } from '../ai-output';
import { ActionUserError, type ActionDeps, type DetailLine } from './action-types';

const flatten = (errs: ValidationError[]): string[] =>
  errs.flatMap((e) => [...Object.values(e.constraints ?? {}).map(viValidation), ...flatten(e.children ?? [])]);

/** Thông điệp MẶC ĐỊNH (tiếng Anh) của class-validator → câu tiếng Việt ngắn cho AI. Thông điệp tự viết trong DTO giữ nguyên. */
const VI_RULES: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^property (\S+) should not exist$/, (m) => `Trường không tồn tại: ${m[1]}`],
  [/^(\S+) should not be (?:empty|null or undefined)$/, (m) => `${m[1]}: bắt buộc`],
  [/^(\S+) must be an integer number$/, (m) => `${m[1]}: phải là số nguyên`],
  [/^(\S+) must be a number conforming to the specified constraints$/, (m) => `${m[1]}: phải là số`],
  [/^(\S+) must be a positive number$/, (m) => `${m[1]}: phải là số dương`],
  [/^(\S+) must be a string$/, (m) => `${m[1]}: phải là chuỗi`],
  [/^(\S+) must be a boolean value$/, (m) => `${m[1]}: phải là true/false`],
  [/^(\S+) must be an array$/, (m) => `${m[1]}: phải là danh sách`],
  [/^(\S+) must be an email$/, (m) => `${m[1]}: email không hợp lệ`],
  [/^(\S+) must be a valid ISO 8601 date string$/, (m) => `${m[1]}: phải là ngày ISO 8601 (vd 2026-12-01T09:00:00Z)`],
  [/^(\S+) must be a Date instance$/, (m) => `${m[1]}: phải là ngày`],
  [/^(\S+) must be (?:longer|shorter) than or equal to (\d+) characters$/, (m) => `${m[1]}: ${/longer/.test(m[0]) ? 'tối thiểu' : 'tối đa'} ${m[2]} ký tự`],
  [/^(\S+) must not be less than (-?[\d.]+)$/, (m) => `${m[1]}: tối thiểu ${m[2]}`],
  [/^(\S+) must not be greater than (-?[\d.]+)$/, (m) => `${m[1]}: tối đa ${m[2]}`],
  [/^(\S+) must be one of the following values: (.+)$/, (m) => `${m[1]}: phải là một trong ${m[2]}`],
  [/^(\S+) must be a valid enum value$/, (m) => `${m[1]}: giá trị không hợp lệ`],
  [/^(\S+) must match .+ regular expression$/, (m) => `${m[1]}: sai định dạng`],
  [/^(\S+) must contain (at least|no more than) (\d+) elements$/, (m) => `${m[1]}: ${m[2] === 'at least' ? 'tối thiểu' : 'tối đa'} ${m[3]} phần tử`],
  [/^each value in (\S+) (.+)$/, (m) => `${m[1]} (mỗi phần tử): ${viValidation(`x ${m[2]}`).replace(/^x: /, '')}`],
];

export function viValidation(msg: string): string {
  for (const [re, fn] of VI_RULES) {
    const m = msg.match(re);
    if (m) return fn(m);
  }
  return msg;
}

/** Kiểm tham số bằng ĐÚNG DTO (class-validator) mà API web dùng; trường lạ bị từ chối. Trả instance DTO để đưa vào service. */
export async function validateDto<T extends object>(cls: new () => T, plain: Record<string, unknown>): Promise<T> {
  const inst = plainToInstance(cls, plain);
  const errs = await validate(inst, { whitelist: true, forbidNonWhitelisted: true });
  if (errs.length) throw new BadRequestException(flatten(errs).join('; '));
  return inst;
}

/** Bỏ khoá `undefined` (DTO ES2022: mọi field là own property) trước khi lưu/so sánh. */
export function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u200b-\u200f\u202a-\u202e\u2060-\u2069\u034f\u061c\ufeff]/g;
/** Văn bản do AI gửi: bỏ ký tự điều khiển/vô hình, chuẩn hoá xuống dòng, cắt độ dài. KHÔNG xử lý HTML (FE luôn hiển thị dạng văn bản thuần). */
export function cleanText(v: unknown, max: number): string {
  return String(v ?? '').normalize('NFC').replace(INVISIBLE, '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}

/** Hiển thị cho người duyệt: che SĐT trong chuỗi tự do + cắt. */
export const shown = (s: string, max = 300): string => {
  const t = maskPhonesInText(s);
  return t.length > max ? `${t.slice(0, max)}…` : t;
};
export const line = (label: string, value: string | number | null | undefined, max = 600): DetailLine | null =>
  value === null || value === undefined || value === '' ? null : { label, value: shown(String(value), max) };
export const lines = (...l: (DetailLine | null)[]): DetailLine[] => l.filter((x): x is DetailLine => x !== null);

export async function optionLabel(deps: ActionDeps, id: number, group: string, field: string): Promise<string> {
  const o = await deps.prisma.settingOption.findUnique({ where: { id }, select: { group_key: true, label: true, is_active: true } });
  if (!o || o.group_key !== group || !o.is_active) {
    throw new BadRequestException(`${field} không hợp lệ — hãy lấy id đúng từ công cụ list_crm_options`);
  }
  return o.label;
}

/** Khách trong phạm vi quyền `perm` của `user` — ngoài phạm vi/không tồn tại ⇒ 404 (không lộ sự tồn tại). */
export async function loadContactInScope(deps: ActionDeps, user: AuthUser, id: number, perm: Permission) {
  const c = await deps.prisma.contact.findFirst({
    where: { id, deleted_at: null },
    select: { id: true, full_name: true, assigned_to: true, created_by_id: true, stage_id: true, stage: { select: { label: true } } },
  });
  if (!c) throw new NotFoundException('Không tìm thấy khách hàng hoặc nằm ngoài phạm vi quyền của bạn');
  try {
    await assertInScope(deps.scope, user, perm, [c.assigned_to, c.created_by_id]);
  } catch {
    throw new NotFoundException('Không tìm thấy khách hàng hoặc nằm ngoài phạm vi quyền của bạn');
  }
  return c;
}

/**
 * Tên hiển thị trong summary sau khi sửa: đổi tên ⇒ "cũ → mới" (summary trả về AI SAU khi thực hiện phải phản ánh giá trị mới),
 * không đổi ⇒ tên cũ.
 */
export function renamed(before: string | null | undefined, after: unknown): string {
  const b = (before ?? '').trim();
  const a = typeof after === 'string' ? after.trim() : '';
  return a && a !== b ? `${b || '(trống)'} → ${a}` : b;
}

export const fmtDateVn = (iso: string): string =>
  new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));

/**
 * Dùng LÚC TẠO NHÁP: ngoài quyền ghi, khách phải nằm trong phạm vi ĐỌC (`contacts.view`) — tên khách đi vào `summary` trả cho AI,
 * nên AI không được biết nhiều hơn những gì tool đọc cho phép (admin có thể cấu hình `contacts.update`/`transfer` rộng hơn `view`).
 */
export async function loadContactForDraft(deps: ActionDeps, user: AuthUser, id: number, perm: Permission) {
  const c = await loadContactInScope(deps, user, id, perm);
  await loadContactInScope(deps, user, id, 'contacts.view');
  return c;
}

/**
 * Gắn khách vào bản ghi khác (việc, deal…) LÚC TẠO NHÁP: khách phải còn tồn tại (chưa xoá) và nằm trong phạm vi `contacts.view`
 * cùng luật với get_contact/list_contacts. Ngoài phạm vi/đã xoá/không có ⇒ một thông báo duy nhất (không lộ sự tồn tại).
 */
export async function assertContactForDraft(deps: ActionDeps, user: AuthUser, contactId: number): Promise<void> {
  try {
    await loadContactInScope(deps, user, contactId, 'contacts.view');
  } catch (e) {
    if (e instanceof NotFoundException) throw new ActionUserError(`contact_id ${contactId}: không tìm thấy khách hàng hoặc nằm ngoài phạm vi quyền của bạn.`);
    throw e;
  }
}
