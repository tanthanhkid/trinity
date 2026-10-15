import { maskPhone } from '@trinity/rbac-nest';
import type { IntegrationEventType } from '@trinity/prisma';

/**
 * Phạm vi xem + quyền SĐT của CHỦ THỂ endpoint (người tạo/sửa gần nhất), tính 1 lần cho mỗi vòng gửi.
 * Mỗi giá trị = kết quả `ScopeService.ownerIds(user, perm)`: danh sách owner id | 'all' | null (không có quyền).
 */
export interface ActorScopes {
  contactsView: number[] | 'all' | null;
  dealsView: number[] | 'all' | null;
  posSell: number[] | 'all' | null;
  phoneFull: number[] | 'all' | null;
  /** — phạm vi xem bản ghi tuỳ biến + quyền SĐT riêng + vai trò (lọc `visible_role_ids` của thực thể). */
  customView: number[] | 'all' | null;
  customPhoneFull: number[] | 'all' | null;
  roleIds: number[];
  canManageCustomObjects: boolean;
  /** Có quyền `social.post` (xem/đăng bài mạng xã hội) ⇒ nhận sự kiện đăng bài. */
  canSocialPost?: boolean;
}

export interface EvaluatedEvent {
  deliver: boolean;
  /** Payload đã che (khi `deliver`). Bản sao — không sửa đầu vào. */
  data: Record<string, unknown>;
}

type Owners = (number | null | undefined)[];
const inScope = (allowed: number[] | 'all' | null, owners: Owners): boolean =>
  allowed === 'all' || (allowed !== null && owners.some((o) => o != null && allowed.includes(o)));

const ALREADY_MASKED = /^\*{3}\d{0,3}$/;
// Cho phép các dấu phân cách hay gặp giữa chữ số của SĐT: khoảng trắng . - / _ (vd `(090) 123 4567`, `0901/234/567`).
const DIGIT_RUN = /\+?[\d(][\d\s.\-()/_]{7,}\d/g;

/** Che SĐT; giữ nguyên chuỗi đã che (idempotent — chạy lại lúc gửi không làm méo). */
function maskValue(v: unknown): unknown {
  if (typeof v !== 'string' || v === '' || ALREADY_MASKED.test(v)) return v;
  return maskPhone(v);
}

/** Văn bản tự do (tên deal, ghi chú, mã tham chiếu) hay bị dán SĐT vào → che mọi dãy ≥ 9 chữ số. */
export function scrubDigitRuns(text: string): string {
  return text.replace(DIGIT_RUN, (m) => {
    const digits = m.replace(/\D/g, '');
    return digits.length >= 9 ? `***${digits.slice(-3)}` : m;
  });
}

const looksLikePhone = (v: unknown): boolean => typeof v === 'string' && v.replace(/\D/g, '').length >= 8;

function scrubFields(obj: Record<string, unknown>, fields: string[]): void {
  for (const f of fields) if (typeof obj[f] === 'string') obj[f] = scrubDigitRuns(obj[f] as string);
}

function maskContact(c: Record<string, unknown>): void {
  c.phone = maskValue(c.phone);
  c.phone_2 = maskValue(c.phone_2);
  // `zalo_account` thường chính là SĐT.
  if (looksLikePhone(c.zalo_account)) c.zalo_account = maskValue(c.zalo_account);
  // Tên/email do người nhập tự do, hay có SĐT ("Chị Lan 0912345678", `0912345678@gmail.com`).
  scrubFields(c, ['full_name', 'email']);
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

function contactOwners(type: IntegrationEventType, data: Obj): Owners {
  const c = asObj(data.contact);
  const owners: Owners = [num(c?.assigned_to), num(c?.created_by_id)];
  if (type === 'contact.assigned') owners.push(num(data.from_user_id), num(data.to_user_id));
  return owners;
}

/** thực thể bị giới hạn vai trò thì CHỈ chủ endpoint thuộc vai trò đó (hoặc giữ `custom_objects.manage`) mới nhận. */
function evaluateCustomRecord(data: Obj, scopes: ActorScopes): EvaluatedEvent {
  const none: EvaluatedEvent = { deliver: false, data: {} };
  const obj = asObj(data.object);
  const rec = asObj(data.record);
  if (!obj || !rec) return none;
  const roles = Array.isArray(obj.visible_role_ids) ? obj.visible_role_ids.filter((x): x is number => typeof x === 'number') : [];
  if (!scopes.canManageCustomObjects) {
    if (obj.is_active === false) return none;
    if (roles.length > 0 && !roles.some((r) => scopes.roleIds.includes(r))) return none;
  }
  const owners: Owners = [num(rec.owner_id), num(rec.created_by)];
  if (!inScope(scopes.customView, owners)) return none;
  if (!inScope(scopes.customPhoneFull, owners)) {
    const rd = asObj(rec.data);
    const phoneKeys = new Set(Array.isArray(rec.phone_fields) ? rec.phone_fields.filter((x): x is string => typeof x === 'string') : []);
    if (rd) {
      for (const [k, v] of Object.entries(rd)) {
        if (phoneKeys.has(k)) rd[k] = maskValue(v);
        else if (typeof v === 'string') rd[k] = scrubDigitRuns(v);
      }
    }
    scrubFields(rec, ['title']);
  }
  return { deliver: true, data };
}

/**
 * Quyết định có gửi sự kiện này cho endpoint không + che SĐT. 🔴 "Không cấp thứ mình không có":
 *  - Sự kiện chỉ được gửi nếu chủ thể XEM được bản ghi (contacts.view / deals.view / pos.sell theo scope).
 *    Thiếu quyền ⇒ bỏ qua (không gửi, không lỗi) — không tự nới.
 *  - SĐT chỉ rõ nếu chủ thể có `contacts.phone_full` phủ owner của bản ghi; ngược lại che `***123`.
 * Thuần (không I/O) để test được; dùng ở cả lúc tạo delivery và lúc gửi (quyền có thể đổi giữa chừng).
 */
export function evaluateEvent(type: IntegrationEventType, payload: unknown, scopes: ActorScopes): EvaluatedEvent {
  const data = JSON.parse(JSON.stringify(payload ?? {})) as Obj;
  const none: EvaluatedEvent = { deliver: false, data: {} };
  if (type.startsWith('contact.')) {
    const owners = contactOwners(type, data);
    if (!inScope(scopes.contactsView, owners)) return none;
    const c = asObj(data.contact);
    if (!inScope(scopes.phoneFull, owners)) {
      if (c) maskContact(c);
      scrubFields(data, ['reason']); // contact.assigned: lý do chuyển do người dùng gõ
    }
    return { deliver: true, data };
  }
  if (type.startsWith('deal.')) {
    const d = asObj(data.deal);
    const owners: Owners = [num(d?.assigned_to), num(d?.created_by)];
    if (!inScope(scopes.dealsView, owners)) return none;
    if (d && !inScope(scopes.phoneFull, owners)) scrubFields(d, ['title', 'description', 'note']);
    return { deliver: true, data };
  }
  if (type === 'pos.order.completed') {
    const o = asObj(data.order);
    const owners: Owners = [num(o?.created_by), num(o?.paid_by)];
    if (!inScope(scopes.posSell, owners)) return none;
    if (o && !inScope(scopes.phoneFull, owners)) {
      scrubFields(o, ['note']);
      for (const p of Array.isArray(o.payments) ? o.payments : []) {
        const po = asObj(p);
        if (po) scrubFields(po, ['reference']);
      }
    }
    return { deliver: true, data };
  }
  if (type.startsWith('custom_record.')) return evaluateCustomRecord(data, scopes);
  if (type.startsWith('zalo_oa.')) {
    // chỉ có định danh, không nội dung/SĐT ⇒ không cần che; giữ theo phạm vi xem khách của chủ thể.
    return inScope(scopes.contactsView, [num(data.contact_assigned_to)]) ? { deliver: true, data } : none;
  }
  if (type.startsWith('messenger.message_') || type === 'facebook.comment_received') {
    // Như Zalo OA: chỉ định danh; theo phạm vi xem khách của chủ thể.
    return inScope(scopes.contactsView, [num(data.contact_assigned_to)]) ? { deliver: true, data } : none;
  }
  // Lượt gửi hàng loạt: chủ endpoint đã có `integrations.webhooks` (đúng quyền của màn Gửi hàng loạt); tên lượt do người dùng gõ ⇒ che SĐT nếu không xem được SĐT.
  if (type === 'messenger.broadcast_finished') {
    if (scopes.phoneFull !== 'all') scrubFields(data, ['name']);
    return { deliver: true, data };
  }
  if (type.startsWith('social_post.')) return scopes.canSocialPost ? { deliver: true, data } : none;
  // Thanh toán: chỉ mã + số tiền + định danh nguồn, không SĐT/nội dung ⇒ chủ endpoint (đã có `integrations.webhooks`) nhận nguyên.
  if (type === 'payment.received') return { deliver: true, data };
  // Đơn online: cùng phạm vi màn Đơn từ trang bán hàng (`deals.view` theo người phụ trách khách); không xem được SĐT ⇒ che SĐT người mua (và số lẫn trong tên/địa chỉ/ghi chú).
  if (type === 'store_order.created') {
    const o = asObj(data.order);
    const owners: Owners = [num(o?.contact_assigned_to)];
    if (!inScope(scopes.dealsView, owners)) return none;
    if (o && !inScope(scopes.phoneFull, owners)) {
      o.customer_phone = maskValue(o.customer_phone);
      scrubFields(o, ['customer_name', 'customer_address', 'note']);
    }
    return { deliver: true, data };
  }
  return none; // loại lạ (không có trong catalog) → không gửi.
}
