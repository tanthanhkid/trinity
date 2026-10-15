import { plainToInstance, Transform } from 'class-transformer';
import { IsEmail, IsObject, IsOptional, IsString, Length, Matches, MaxLength, validateSync } from 'class-validator';

/** Chuẩn hoá SĐT VN về `0xxxxxxxxx` (cùng quy tắc `toLocalPhoneNumber` của contacts.service). Không ra dạng hợp lệ → null. */
export function normalizeVnPhone(raw: string): string | null {
  const cleaned = raw.replace(/[\s.\-()]/g, '');
  if (!/^\+?\d+$/.test(cleaned)) return null;
  const d = cleaned.replace(/\D/g, '');
  let local: string;
  if (d.startsWith('84') && d.length === 11) local = `0${d.slice(2)}`;
  else if (d.startsWith('0') && d.length === 10) local = d;
  else if (d.length === 9 && /^[35789]/.test(d)) local = `0${d}`;
  else return null;
  return /^0\d{9}$/.test(local) ? local : null; // cùng ràng buộc `POST /public/contacts` (0 + 9 số)
}

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
export const MAX_EXTRA_BYTES = 4096;
export const MAX_BODY_BYTES = 64 * 1024;

export class InboundContactPayload {
  @Transform(trim)
  @IsString({ message: 'name phải là chuỗi' })
  @Length(1, 100, { message: 'name từ 1 đến 100 ký tự' })
  name!: string;

  @Transform(trim)
  @IsString({ message: 'phone phải là chuỗi' })
  @MaxLength(32, { message: 'phone quá dài' })
  phone!: string;

  @IsOptional()
  @Transform(trim)
  @IsEmail({}, { message: 'email không hợp lệ' })
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000, { message: 'note tối đa 2000 ký tự' })
  note?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100, { message: 'source tối đa 100 ký tự' })
  source?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(/^[A-Za-z0-9._:\-]{1,128}$/, { message: 'external_id chỉ gồm chữ/số . _ : - (tối đa 128 ký tự)' })
  external_id?: string;

  @IsOptional()
  @IsObject({ message: 'extra phải là object' })
  extra?: Record<string, unknown>;
}

export interface ParsedInbound {
  name: string;
  phone: string; // đã chuẩn hoá 0xxxxxxxxx
  email?: string;
  note?: string;
  source?: string;
  external_id?: string;
  extra?: Record<string, unknown>;
}

export type ParseResult = { ok: true; value: ParsedInbound } | { ok: false; errors: string[] };

/**
 * Kiểm payload SAU khi đã xác thực token/chữ ký (người chưa xác thực không nhìn thấy thông điệp validate).
 * Lỗi chỉ nêu tên trường/ràng buộc, KHÔNG chép lại giá trị (SĐT) vào thông điệp.
 */
export function parseInboundPayload(body: unknown): ParseResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, errors: ['Body phải là object JSON'] };
  const inst = plainToInstance(InboundContactPayload, body, { exposeDefaultValues: false });
  const errs = validateSync(inst, { whitelist: true, forbidUnknownValues: true });
  const errors = errs.flatMap((e) => Object.values(e.constraints ?? {}));
  const phone = typeof inst.phone === 'string' ? normalizeVnPhone(inst.phone) : null;
  if (!phone && !errs.some((e) => e.property === 'phone')) errors.push('phone không hợp lệ (SĐT Việt Nam, vd 0912345678 hoặc +84912345678)');
  if (inst.extra !== undefined && Buffer.byteLength(JSON.stringify(inst.extra)) > MAX_EXTRA_BYTES) {
    errors.push(`extra tối đa ${MAX_EXTRA_BYTES} byte`);
  }
  if (errors.length > 0 || !phone) return { ok: false, errors };
  const { name, email, note, source, external_id, extra } = inst;
  return { ok: true, value: { name, phone, email, note, source, external_id, extra } };
}
