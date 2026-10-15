export interface ParsedRange {
  start: number;
  end: number;
}

/**
 * Parse header HTTP `Range` (RFC 7233) dạng đơn `bytes=start-end` / `bytes=start-`
 * / `bytes=-suffixLength`. Trả `null` khi không có range, cú pháp lạ, multi-range
 * (`bytes=0-1,2-3` — driver này KHÔNG hỗ trợ), hoặc range không thoả `size` —
 * mọi trường hợp `null` đều nghĩa là "phục vụ full object 200", KHÔNG throw.
 */
export function parseRange(range: string | undefined, size: number): ParsedRange | null {
  if (!range || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) return null; // multi-range hoặc cú pháp lạ → fallback full object

  const [, startRaw, endRaw] = match;
  if (startRaw === '' && endRaw === '') return null;

  let start: number;
  let end: number;
  if (startRaw === '') {
    // Suffix range: `bytes=-500` = 500 byte CUỐI file.
    const suffixLength = Number(endRaw);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === '' ? size - 1 : Number(endRaw);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end) {
    return null;
  }
  end = Math.min(end, size - 1);
  if (start > end) return null;

  return { start, end };
}
