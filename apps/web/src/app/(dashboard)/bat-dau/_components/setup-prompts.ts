/**
 * Câu mẫu để dán vào ChatGPT/Claude/Gemini sau khi nối Trinity. Văn bản thuần, lời người dùng thường —
 * KHÔNG ghi tên công cụ: AI tự tìm công cụ hợp (mô tả công cụ dẫn đường), người đọc màn này không cần biết.
 */
export const SETUP_PROMPTS: readonly { key: string; title: string; text: string }[] = [
  {
    key: "build",
    title: "Dựng hệ thống lần đầu",
    text: "Mình muốn dùng Trinity để quản lý công việc của công ty. Bạn hỏi mình từng câu một về cách công ty đang làm: bán gì, khách đi qua những bước nào từ lúc hỏi tới lúc mua và chăm sóc, ai phụ trách việc gì, đang theo dõi bằng sổ hay file nào. Hỏi xong thì tóm tắt lại cho mình xác nhận rồi dựng luôn trên Trinity.",
  },
  {
    key: "import",
    title: "Đưa dữ liệu đang có vào",
    text: "Đây là file mình đang dùng để theo dõi: <dán link Google Sheet hoặc đính kèm file Excel>. Bạn đọc file, cho mình xem cột nào sẽ vào chỗ nào trong Trinity, mình đồng ý thì nhập vào.",
  },
  {
    key: "kanban",
    title: "Thêm màn kéo thả theo trạng thái",
    text: "Tạo cho mình màn kéo thả của <tên danh sách>, chia cột theo <trạng thái>, rồi đưa lên menu.",
  },
  {
    key: "ask",
    title: "Hỏi tình hình hằng ngày",
    text: "Hôm nay công ty có gì mới trên Trinity? Có bao nhiêu khách mới, việc nào sắp trễ hạn, ai cần mình hỗ trợ?",
  },
]
