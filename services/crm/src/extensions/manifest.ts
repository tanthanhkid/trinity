import { DEFAULT_LIMITS, MAX_LIMITS, type ExtKind, type Limits } from './runner/types';
import { validateSchedule } from './cron';
import { ExtensionInputError } from './extension-errors';

export interface ExtManifest {
  /** Host mạng được phép (`host` hoặc `host:port`). Cổng nội bộ của Trinity tự được thêm khi cần. */
  net: string[];
  /** Bảng DỮ LIỆU (khoá bảng tuỳ biến) được đọc / được ghi — mọi truy cập đi qua cổng nội bộ, ngoài phạm vi ⇒ 403. */
  tables: { read: string[]; write: string[] };
  /** Chỉ `job`: lịch cron 5 trường, giờ Việt Nam. */
  schedule?: string;
  /** Chỉ `tool`: JSON Schema (object) của tham số tool. */
  input_schema?: Record<string, unknown>;
  limits?: Partial<Limits>;
}

export const KINDS: readonly ExtKind[] = ['job', 'api', 'tool'];
export const MAX_CODE_BYTES = 256 * 1024;
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TABLE_RE = /^[a-z][a-z0-9_]{0,39}$/;
// host hoặc host:port; không cho `*`, dấu phẩy, khoảng trắng, `--` (chống chèn cờ vào dòng lệnh Deno).
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|\[[0-9a-f:]+\])(?::\d{1,5})?$/;
const MAX_SCHEMA_BYTES = 8 * 1024;
const MAX_NET = 20;
const MAX_TABLES = 30;

function isInternalIpv4(a: number, b: number): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224 || (a === 100 && b >= 64 && b <= 127);
}

/** Bung IPv6 (dạng nén `::`, đuôi IPv4 chấm) thành 8 nhóm 16 bit; null nếu sai cú pháp. */
function parseIpv6(raw: string): number[] | null {
  let s = raw;
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (tail) {
    const o = tail.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    s = s.slice(0, tail.index) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const parts = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (parts.length !== 8 || parts.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  return parts.map((x) => parseInt(x, 16));
}

/** IPv6 nội bộ: unspecified/loopback, ULA fc00::/7, link-local fe80::/10, và dạng IPv4 nhúng (::ffff:a.b.c.d, ::a.b.c.d, 64:ff9b::/96) theo luật IPv4. Cú pháp lạ ⇒ coi là nội bộ (fail closed). */
function isInternalIpv6(name: string): boolean {
  const g = parseIpv6(name);
  if (!g) return true;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] <= 1) return true; // :: và ::1
  if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80) return true;
  const embedded =
    (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) ||
    (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0));
  return embedded ? isInternalIpv4(g[6] >> 8, g[6] & 0xff) : false;
}

/** Địa chỉ loopback / mạng riêng / link-local (metadata đám mây) — chương trình con KHÔNG được khai, vì sẽ chạm được Postgres/Redis/monolith. */
export function isInternalHost(host: string): boolean {
  const name = host.replace(/:\d{1,5}$/, '').replace(/^\[|\]$/g, '');
  // Dịch vụ DNS "ký sinh IP" (127.0.0.1.nip.io, localtest.me…) trỏ về loopback/mạng riêng: Deno cho qua vì so tên chứ không so IP đã phân giải.
  if (/(^|\.)(nip\.io|sslip\.io|xip\.io|localtest\.me|lvh\.me|vcap\.me|traefik\.me|localhost\.run|lacolhost\.com)$/.test(name)) return true;
  // Tên chứa nguyên một IPv4 (a-b-c-d hoặc a.b.c.d làm nhãn) — dấu hiệu wildcard-DNS, và số nguyên/thập lục (2130706433, 0x7f000001, 0177.0.0.1).
  if (/(^|[.-])\d{1,3}[.-]\d{1,3}[.-]\d{1,3}[.-]\d{1,3}([.-]|$)/.test(name) && !/^\d+\.\d+\.\d+\.\d+$/.test(name)) return true;
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*$/.test(name) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return true;
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') || name.endsWith('.internal')) return true;
  if (name.includes(':')) return isInternalIpv6(name); // IPv6 loopback / ULA / link-local / IPv4 nhúng
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(name);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return isInternalIpv4(a, b);
}

const asStrings = (v: unknown, what: string, max: number): string[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new ExtensionInputError(`${what} phải là danh sách chữ.`);
  if (v.length > max) throw new ExtensionInputError(`${what} tối đa ${max} mục.`);
  return [...new Set((v as string[]).map((x) => x.trim().toLowerCase()))];
};

function checkNet(net: string[]): void {
  for (const h of net) {
    if (!HOST_RE.test(h)) throw new ExtensionInputError(`Host mạng không hợp lệ: "${h}" (chỉ tên miền hoặc tên miền:cổng, không dùng ký tự đại diện).`);
    if (isInternalHost(h)) throw new ExtensionInputError(`Không được khai địa chỉ nội bộ: "${h}" (chương trình con không được chạm máy chủ/cơ sở dữ liệu của hệ thống).`);
  }
}

function checkTables(list: string[], what: string): void {
  for (const t of list) if (!TABLE_RE.test(t)) throw new ExtensionInputError(`Tên bảng ${what} không hợp lệ: "${t}".`);
}

function readTables(raw: unknown): { read: string[]; write: string[] } {
  const t = (raw ?? {}) as { read?: unknown; write?: unknown };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ExtensionInputError('tables phải là {read: [...], write: [...]}.');
  const read = asStrings(t.read, 'tables.read', MAX_TABLES);
  const write = asStrings(t.write, 'tables.write', MAX_TABLES);
  checkTables(read, 'đọc');
  checkTables(write, 'ghi');
  return { read, write };
}

function readLimits(raw: unknown): Partial<Limits> | undefined {
  if (raw === undefined) return undefined;
  const l = raw as Partial<Limits>;
  const out: Limits = { ...DEFAULT_LIMITS, ...l };
  if (!(out.timeoutMs > 0 && out.timeoutMs <= MAX_LIMITS.timeoutMs)) throw new ExtensionInputError(`limits.timeoutMs phải trong (0, ${MAX_LIMITS.timeoutMs}].`);
  if (!(out.memoryMb >= 16 && out.memoryMb <= MAX_LIMITS.memoryMb)) throw new ExtensionInputError(`limits.memoryMb phải trong [16, ${MAX_LIMITS.memoryMb}].`);
  return { timeoutMs: out.timeoutMs, memoryMb: out.memoryMb };
}

function readSchema(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw) || (raw as { type?: unknown }).type !== 'object') throw new ExtensionInputError('input_schema phải là JSON Schema kiểu object.');
  if (JSON.stringify(raw).length > MAX_SCHEMA_BYTES) throw new ExtensionInputError('input_schema quá lớn.');
  return raw as Record<string, unknown>;
}

export function validateKey(key: unknown): string {
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw new ExtensionInputError('key chỉ gồm a-z, 0-9 và gạch ngang (tối đa 40, bắt đầu bằng chữ/số).');
  return key;
}

export function validateKind(kind: unknown): ExtKind {
  if (typeof kind !== 'string' || !KINDS.includes(kind as ExtKind)) throw new ExtensionInputError('kind phải là job, api hoặc tool.');
  return kind as ExtKind;
}

/** Kiểm + chuẩn hoá manifest theo loại. Ném ExtensionInputError (thông điệp tiếng Việt) nếu sai. */
export function parseManifest(kind: ExtKind, raw: unknown): ExtManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ExtensionInputError('manifest phải là một đối tượng.');
  const m = raw as Record<string, unknown>;
  const net = asStrings(m.net, 'net', MAX_NET);
  checkNet(net);
  const out: ExtManifest = { net, tables: readTables(m.tables ?? {}) };
  if (kind === 'job') {
    if (typeof m.schedule !== 'string' || !m.schedule.trim()) throw new ExtensionInputError('Job cần "schedule" (cron 5 trường, giờ Việt Nam), ví dụ "0 8 * * *".');
    validateSchedule(m.schedule);
    out.schedule = m.schedule.trim().replace(/\s+/g, ' ');
  } else if (m.schedule !== undefined) throw new ExtensionInputError('Chỉ job mới có "schedule".');
  if (kind === 'tool') out.input_schema = readSchema(m.input_schema) ?? { type: 'object', properties: {} };
  else if (m.input_schema !== undefined) throw new ExtensionInputError('Chỉ tool mới có "input_schema".');
  const limits = readLimits(m.limits);
  if (limits) out.limits = limits;
  return out;
}

export function checkCode(code: unknown): string {
  if (typeof code !== 'string' || !code.trim()) throw new ExtensionInputError('code (mã TypeScript) không được rỗng.');
  if (Buffer.byteLength(code) > MAX_CODE_BYTES) throw new ExtensionInputError(`Mã quá lớn (tối đa ${MAX_CODE_BYTES / 1024} KB).`);
  return code;
}

export const limitsOf = (m: ExtManifest): Limits => ({ ...DEFAULT_LIMITS, ...m.limits });
