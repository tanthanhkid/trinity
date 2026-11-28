import { formatDateTime } from "@/lib/format"
import type { FacebookPageView } from "./use-facebook"

/** Tông màu dùng chung cho chip, dấu tick và chấm nhật ký (ánh xạ sang token --ax-success/danger/warn). */
export type FbTone = "ok" | "bad" | "off" | "warn"

export type FbPageState = "disconnected" | "bad" | "paused" | "running"

export const tokenBad = (p: FacebookPageView) => p.token_status === "invalid" || p.token_status === "expired"

export function pageState(p: FacebookPageView): FbPageState {
  if (p.disconnected) return "disconnected"
  if (tokenBad(p)) return "bad"
  return p.is_active ? "running" : "paused"
}

export const STATE_LABEL: Record<FbPageState, string> = {
  disconnected: "Đã ngắt",
  bad: "Cần nối lại",
  paused: "Đang tắt",
  running: "Đang chạy",
}

export const STATE_TONE: Record<FbPageState, FbTone> = { disconnected: "off", bad: "bad", paused: "warn", running: "ok" }

/** Khối nhấn đầu trang: tiêu đề + lời giải thích theo trạng thái thật của Page. */
export function pageBanner(p: FacebookPageView): { title: string; text: string } {
  switch (pageState(p)) {
    case "disconnected":
      return { title: "Page đã ngắt kết nối", text: "Không có tin nhắn hay lead nào về Trinity từ Page này." }
    case "bad":
      return {
        title: "Đang không nhận được tin của khách",
        text: `${p.token_status === "expired" ? "Token" : "Quyền truy cập"} của "${p.name}" ${p.token_status === "expired" ? "đã hết hạn" : "đã bị Facebook thu hồi"}. Nối lại để nhận tiếp tin nhắn và lead; tin khách gửi trong lúc dừng có thể phải lấy lại trên Facebook.`,
      }
    case "paused":
      return { title: "Đang tắt nhận tin", text: 'Bật lại ở mục "Cách nhận khách" để nhận tin.' }
    default:
      return { title: "Đang hoạt động", text: `Mọi kiểm tra đều ổn. Khách nhắn vào "${p.name}" sẽ về Hộp thư.` }
  }
}

export interface FbCheck { title: string; tone: FbTone; mark: string; tag: string; text: string }

/** Ba dòng «Tình trạng kết nối» — chỉ dùng trường API thật (token, đăng ký webhook, đăng bài). */
export function pageChecks(p: FacebookPageView): FbCheck[] {
  const state = pageState(p)
  const posting: FbCheck =
    p.posting === "on"
      ? { title: "Đăng bài lên Page", tone: "ok", mark: "✓", tag: "Ổn", text: "Đã cấp quyền đăng bài." }
      : { title: "Đăng bài lên Page", tone: "off", mark: "–", tag: p.posting === "removed" ? "Đã gỡ" : "Chưa nối", text: "Không bắt buộc. Chỉ cần khi đăng bài từ Trinity." }
  if (state === "disconnected") {
    return [
      { title: "Token truy cập", tone: "off", mark: "–", tag: "Chưa nối", text: "Đã xoá khi ngắt kết nối." },
      { title: "Nhận tin về Trinity", tone: "off", mark: "–", tag: "Chưa nối", text: "Đã huỷ đăng ký webhook." },
      { ...posting, tone: "off", mark: "–", tag: "Chưa nối", text: "Nối lại Page để dùng." },
    ]
  }
  if (state === "bad") {
    return [
      { title: "Token truy cập", tone: "bad", mark: "!", tag: "Lỗi", text: "Facebook đã thu hồi quyền truy cập hoặc token hết hạn. Cần người quản lý Page đăng nhập lại và cấp đủ quyền." },
      { title: "Nhận tin về Trinity", tone: "bad", mark: "!", tag: "Đang dừng", text: "Tạm dừng nhận tin nhắn và lead cho tới khi token dùng lại được." },
      posting,
    ]
  }
  const receiving: FbCheck = !p.is_active
    ? { title: "Nhận tin về Trinity", tone: "off", mark: "–", tag: "Đang tắt", text: "Bạn đang tắt nhận tin cho Page này." }
    : p.subscribed
      ? { title: "Nhận tin về Trinity", tone: "ok", mark: "✓", tag: "Ổn", text: "Tin nhắn, bình luận và lead của Page về Trinity trong vài giây." }
      : { title: "Nhận tin về Trinity", tone: "warn", mark: "!", tag: "Chưa đăng ký", text: 'Page chưa nhận tin nhắn về Trinity. Bấm "Kiểm tra lại"; vẫn báo thì kết nối lại Fanpage và cấp đủ quyền quản lý Page.' }
  return [
    { title: "Token truy cập", tone: "ok", mark: "✓", tag: "Ổn", text: p.token_status === "unknown" ? "Chưa kiểm tra. Bấm “Kiểm tra lại”." : "Token còn hiệu lực. Trinity tự kiểm định kỳ." },
    receiving,
    posting,
  ]
}

export interface FbEvent { text: string; when: string; tone: FbTone | "info" }

/** Nhật ký gần đây dựng từ mốc thật của Page (kiểm token, ngày kết nối, ngắt); chưa có bảng sự kiện riêng cho từng Page. */
export function pageEvents(p: FacebookPageView): FbEvent[] {
  const rows: Array<FbEvent & { at: string }> = []
  if (p.token_checked_at) {
    rows.push({ at: p.token_checked_at, text: `Kiểm token: ${p.token_status === "active" ? "còn hiệu lực" : p.token_status === "unknown" ? "chưa rõ" : p.token_status === "expired" ? "đã hết hạn" : "Facebook đã thu hồi quyền truy cập của Page"}`, when: formatDateTime(p.token_checked_at), tone: p.token_status === "active" ? "ok" : p.token_status === "unknown" ? "info" : "bad" })
  }
  if (p.disconnected) rows.push({ at: p.token_checked_at ?? p.created_at, text: "Đã ngắt kết nối Page", when: formatDateTime(p.token_checked_at ?? p.created_at), tone: "info" })
  rows.push({ at: p.created_at, text: "Kết nối Page vào Trinity", when: formatDateTime(p.created_at), tone: "info" })
  return rows.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 5).map((r) => ({ text: r.text, when: r.when, tone: r.tone }))
}

export const initials = (name: string) =>
  name.trim().split(/\s+/).slice(-2).map((w) => w[0]?.toUpperCase() ?? "").join("")
