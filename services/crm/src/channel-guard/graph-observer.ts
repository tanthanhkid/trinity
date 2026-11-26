/**
 * Cầu nối nhẹ giữa các chỗ gọi Graph API (GraphClient, graphCall của Đăng đa kênh) và `ChannelGuardService`:
 * mỗi lần gọi báo kết quả để đếm tỉ lệ lỗi chặn/spam theo công ty. Không phụ thuộc Nest nên module nào cũng import được;
 * không có người nghe (test, bản một công ty) thì không làm gì.
 */
export interface GraphOutcome {
  ok: boolean;
  httpStatus: number;
  code: number | null;
  subcode: number | null;
  /** true = lời gọi GỬI RA (tin, trả lời/ẩn bình luận, đăng bài). Lời gọi đọc (insights, hội thoại, token…) không tính vào ngưỡng từng công ty. */
  send: boolean;
}

type Observer = (o: GraphOutcome) => void;

let observer: Observer | null = null;

export function setGraphObserver(fn: Observer | null): void {
  observer = fn;
}

export function observeGraph(o: GraphOutcome): void {
  if (!observer) return;
  try {
    observer(o);
  } catch {
    // theo dõi lỗi không bao giờ được làm hỏng lời gọi thật
  }
}

/**
 * Giới hạn cấp APP (#4, #613, HTTP 429): dùng chung cho mọi công ty nên KHÔNG tính vào ngưỡng của một công ty;
 * `ChannelGuardService` xử lý bằng backoff chung (tạm lùi gửi tự động toàn app vài phút).
 */
export function isGraphAppLevelLimit(o: Pick<GraphOutcome, 'httpStatus' | 'code'>): boolean {
  return o.httpStatus === 429 || o.code === 4 || o.code === 613;
}

/**
 * Lỗi của lời gọi GỬI RA do hành vi của một công ty (tính vào ngưỡng tự tạm dừng): #368 vi phạm chính sách/spam, #551 người nhận
 * không khả dụng, #17 / #32 giới hạn theo người dùng / Page. KHÔNG tính: lời gọi đọc; giới hạn cấp app; ngoài cửa sổ 24h
 * (subcode 2018278, mã 1545041); token hết hạn (190); lỗi quyền thường gặp (#10, #200–#299 — Page thiếu quyền là việc cấu hình của chính công ty).
 */
export function isGraphBlockOutcome(o: Pick<GraphOutcome, 'httpStatus' | 'code' | 'subcode' | 'send'>): boolean {
  if (!o.send) return false;
  if (isGraphAppLevelLimit(o)) return false;
  if (o.subcode === 2018278 || o.code === 1545041) return false;
  return o.code !== null && [368, 551, 17, 32].includes(o.code);
}

/** #368 = Meta đã đánh dấu vi phạm chính sách/spam: dấu hiệu nặng nhất. */
export const GRAPH_POLICY_CODE = 368;
