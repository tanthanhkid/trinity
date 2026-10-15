/**
 * Gắn UTM vào liên kết trong bài đăng. Chỉ chạy lúc đăng (nội dung lưu trong bài vẫn sạch); cấu hình lưu ở `options.utm` của từng kênh.
 */
export interface UtmInput {
  campaign: string;
  content?: string;
}

/** Tham số UTM của một kênh: source = tên mạng. */
export type UtmParams = Record<string, string>;

const UNSAFE = /[&#=?%/\\]/;
const MAX_LEN = 100;
/** Dấu câu cuối câu luôn không thuộc liên kết. */
/** Dấu câu / dấu markdown cuối câu luôn không thuộc liên kết (vd `**https://shop.vn**`, `` `https://x.vn` ``). */
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', "'", '"', '”', '’', '…', '>', '*', '~', '`', '|', '。', '，', '、', '；', '：', '！', '？', '）', '】', '」']);
/** Liên kết dài hơn thế thì không gắn (chặn chuỗi bất thường làm chậm). */
const MAX_URL = 2048;
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

function slug(v: string, label: string, min: number): string {
  const s = v.trim().replace(/\s+/g, '-');
  if (s.length < min) throw new Error(`UTM: ${label} không được để trống.`);
  if (s.length > MAX_LEN) throw new Error(`UTM: ${label} tối đa ${MAX_LEN} ký tự.`);
  if (UNSAFE.test(s)) throw new Error(`UTM: ${label} không được chứa các ký tự & # = ? % /.`);
  return s;
}

/** Chuẩn hoá cấu hình UTM người dùng gửi: null/undefined/rỗng ⇒ null; sai ⇒ ném Error tiếng Việt. */
export function normalizeUtm(raw: unknown): UtmInput | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('UTM: định dạng không hợp lệ.');
  const r = raw as Record<string, unknown>;
  if (typeof r.campaign !== 'string') throw new Error('UTM: cần chiến dịch (campaign) 1–100 ký tự.');
  const out: UtmInput = { campaign: slug(r.campaign, 'tên chiến dịch (campaign)', 1) };
  if (r.content !== undefined && r.content !== null && r.content !== '') {
    if (typeof r.content !== 'string') throw new Error('UTM: utm_content phải là chữ.');
    const c = r.content.trim();
    if (c) out.content = slug(c, 'utm_content', 1);
  }
  return out;
}

/** Bộ tham số cho một mạng: source = mạng, medium = social. */
export function utmParamsFor(network: string, utm: UtmInput): UtmParams {
  const p: UtmParams = { utm_source: network, utm_medium: 'social', utm_campaign: utm.campaign };
  if (utm.content) p.utm_content = utm.content;
  return p;
}

/** Cắt dấu câu đuôi không thuộc liên kết (ngoặc đóng chỉ giữ khi có ngoặc mở tương ứng trong liên kết). Đếm ngoặc một lần — tuyến tính. */
function trimTail(url: string): string {
  const count: Record<string, number> = {};
  for (const ch of url) if (ch in CLOSERS || Object.values(CLOSERS).includes(ch)) count[ch] = (count[ch] ?? 0) + 1;
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1];
    if (TRAILING.has(last)) end--;
    else if (CLOSERS[last] && (count[last] ?? 0) > (count[CLOSERS[last]] ?? 0)) {
      count[last]--;
      end--;
    } else break;
  }
  return url.slice(0, end);
}

function tag(url: string, params: UtmParams): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return url;
  for (const k of parsed.searchParams.keys()) if (k.toLowerCase().startsWith('utm_')) return url;
  const h = url.indexOf('#');
  const base = h >= 0 ? url.slice(0, h) : url;
  const hash = h >= 0 ? url.slice(h) : '';
  const sep = !base.includes('?') ? '?' : base.endsWith('?') || base.endsWith('&') ? '' : '&';
  return `${base}${sep}${new URLSearchParams(params).toString()}${hash}`;
}

/** Thêm tham số UTM vào mọi liên kết http(s) chưa có tham số `utm_*`. Gọi hai lần cho cùng kết quả. */
export function applyUtm(text: string, params: UtmParams | null | undefined): string {
  if (!text || !params || Object.keys(params).length === 0) return text;
  return text.replace(/https?:\/\/[^\s<>"]+/gi, (m) => {
    if (m.length > MAX_URL) return m;
    const url = trimTail(m);
    return tag(url, params) + m.slice(url.length);
  });
}

/** Liên kết đầu tiên sau khi gắn UTM (xem trước); không có liên kết ⇒ null. */
export function firstUtmLink(text: string, params: UtmParams | null | undefined): string | null {
  const m = /https?:\/\/[^\s<>"]+/i.exec(text ?? '');
  if (!m) return null;
  const url = trimTail(m[0]);
  return params ? tag(url, params) : url;
}

/** Áp UTM của một kênh lên nội dung + các tuỳ chọn có chữ (mô tả YouTube, bình luận đầu Facebook). Không có `options.utm` ⇒ giữ nguyên. */
export function applyUtmToTarget(network: string, text: string, options: Record<string, unknown>): { text: string; options: Record<string, unknown> } {
  let utm: UtmInput | null = null;
  try {
    utm = normalizeUtm(options.utm);
  } catch {
    utm = null;
  }
  if (!utm) return { text, options };
  const params = utmParamsFor(network, utm);
  const next = { ...options };
  // YouTube lấy tiêu đề từ dòng đầu nội dung khi không đặt title: chốt tiêu đề từ chữ SẠCH, tránh "?utm_source=…" lộ trên tiêu đề công khai.
  if (network === 'youtube' && !(typeof next.title === 'string' && next.title.trim())) {
    const first = text.split('\n').find((l) => l.trim());
    if (first) next.title = first;
  }
  for (const k of ['description', 'first_comment'] as const) if (typeof next[k] === 'string') next[k] = applyUtm(next[k] as string, params);
  return { text: applyUtm(text, params), options: next };
}
