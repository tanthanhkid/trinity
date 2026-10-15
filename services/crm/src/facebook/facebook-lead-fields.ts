import { normalizeVnPhone } from '../integrations/webhooks/inbound/inbound-payload';

export interface LeadFieldData {
  name: string;
  values: string[];
}

export interface ParsedLead {
  full_name: string | null;
  phone: string | null;
  email: string | null;
  /** Các trường còn lại (câu hỏi tuỳ biến của form) — đưa vào ghi chú. */
  others: Array<{ name: string; value: string }>;
}

const PHONE_KEYS = new Set(['phone_number', 'phone', 'mobile_phone', 'so_dien_thoai']);
const EMAIL_KEYS = new Set(['email', 'work_email']);
const NAME_KEYS = new Set(['full_name', 'name', 'ho_ten']);

/**
 * `field_data` của Lead Ads → khách. Tên trường chuẩn của Meta: `full_name`, `first_name`, `last_name`, `email`, `phone_number`.
 * SĐT chuẩn hoá về `0xxxxxxxxx` (không ra dạng hợp lệ ⇒ null và coi như không có SĐT).
 * Doc: https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving
 */
export function parseLeadFields(fieldData: unknown): ParsedLead {
  const out: ParsedLead = { full_name: null, phone: null, email: null, others: [] };
  if (!Array.isArray(fieldData)) return out;
  let first = '';
  let last = '';
  for (const raw of fieldData as LeadFieldData[]) {
    const key = String(raw?.name ?? '').toLowerCase();
    const value = Array.isArray(raw?.values) ? String(raw.values[0] ?? '').trim() : '';
    if (!key || !value) continue;
    if (PHONE_KEYS.has(key)) out.phone = out.phone ?? normalizeVnPhone(value);
    else if (EMAIL_KEYS.has(key)) out.email = out.email ?? (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? value.slice(0, 254) : null);
    else if (NAME_KEYS.has(key)) out.full_name = out.full_name ?? value.slice(0, 100);
    else if (key === 'first_name') first = value;
    else if (key === 'last_name') last = value;
    else out.others.push({ name: key.slice(0, 60), value: value.slice(0, 300) });
  }
  if (!out.full_name && (first || last)) out.full_name = `${last} ${first}`.trim().slice(0, 100);
  return out;
}
