import type { AiActionDraft } from '@prisma/client';
import { maskPhonesInText } from '../ai-output';
import type { DetailLine } from './action-types';
import { actionToolByName } from './action-registry';

export type DraftStatus = 'pending' | 'approved' | 'executed' | 'rejected' | 'expired' | 'failed';
/** `executed` = AI ghi thẳng (không qua duyệt) và đã xong. Trạng thái hiển thị: thêm `executing` (đã nhận duyệt, đang chạy, chưa có kết quả). Không lưu trong DB. */
export type ViewStatus = DraftStatus | 'executing';

/** Quá ngần này mà vẫn `approved` + chưa có `result` ⇒ tiến trình đã chết giữa chừng (restart/OOM): kết quả KHÔNG rõ. */
export const EXECUTION_STALE_MS = 5 * 60 * 1000;
export const STALE_EXECUTION_ERROR = 'Không rõ kết quả: máy chủ khởi động lại khi đang thực hiện. Hãy kiểm tra dữ liệu thủ công trước khi nhờ AI đề xuất lại.';

/**
 * Trạng thái HIỆU LỰC (không phụ thuộc job dọn): `pending` quá hạn ⇒ `expired`; `approved` chưa có `result` ⇒ `executing`
 * (trong cửa sổ ngắn) hoặc `failed` (kết quả không rõ — tiến trình chết giữa chừng).
 */
export function effectiveStatus(row: Pick<AiActionDraft, 'status' | 'expires_at'> & Partial<Pick<AiActionDraft, 'result' | 'decided_at'>>, now = Date.now()): ViewStatus {
  if (row.status === 'pending' && row.expires_at.getTime() <= now) return 'expired';
  if (row.status === 'approved' && (row.result === null || row.result === undefined) && row.decided_at) {
    return now - row.decided_at.getTime() > EXECUTION_STALE_MS ? 'failed' : 'executing';
  }
  return row.status as DraftStatus;
}

export interface DraftView {
  id: number;
  tool: string;
  tool_label: string;
  client_name: string | null;
  summary: string;
  details: DetailLine[];
  status: ViewStatus;
  result: unknown;
  error: string | null;
  created_at: Date;
  decided_at: Date | null;
  expires_at: Date;
  /** ảnh hưởng đổi cấu trúc (hộp đỏ + tên bảng phải gõ). */
  impact: unknown;
}

const asDetails = (v: unknown): DetailLine[] =>
  Array.isArray(v)
    ? v.filter((x): x is DetailLine => !!x && typeof (x as DetailLine).label === 'string' && typeof (x as DetailLine).value === 'string').slice(0, 20)
    : [];

/**
 * Dạng trả ra API/web. 🔴 KHÔNG BAO GIỜ trả `params` thô (có thể chứa SĐT đầy đủ): chỉ `summary`/`details` đã che SĐT.
 * Mọi chuỗi là văn bản thuần (FE hiển thị bằng text node, không render HTML).
 */
export function toView(row: AiActionDraft, clientName: string | null): DraftView {
  return {
    id: row.id,
    tool: row.tool,
    tool_label: actionToolByName(row.tool)?.label ?? row.tool,
    client_name: clientName,
    summary: row.summary,
    details: asDetails(row.details),
    status: effectiveStatus(row),
    result: row.result ?? null,
    error: row.error ? maskPhonesInText(row.error) : effectiveStatus(row) === 'failed' && row.status === 'approved' ? STALE_EXECUTION_ERROR : null,
    created_at: row.created_at,
    decided_at: row.decided_at,
    expires_at: row.expires_at,
    impact: row.impact ?? null,
  };
}
