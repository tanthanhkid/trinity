// nhom event_type dung de tach badge "Tin nhan & de cap"
// (icon MessageSquare) khoi badge "Thong bao" chung (icon Bell).
//
// QUAN TRONG: danh sach nay PHAI khop 1-1 voi
// `notification-display.ts` của web app (MESSAGE_EVENT_TYPES).
// Neu them/bo event_type moi thuoc nhom "tin nhan", sua CA HAI noi.
export const MESSAGE_EVENT_TYPES = [
  'chat.tag',
  'internal.message',
] as const
