"use client"

const STEPS: readonly { title: string; steps: readonly string[] }[] = [
  {
    title: "ChatGPT (Plus / Business / Enterprise)",
    steps: [
      "Trong ChatGPT, vào Settings › Apps & Connectors › Advanced rồi bật Developer mode.",
      "Chọn Create (tạo kết nối mới), đặt tên Trinity CRM và dán địa chỉ kết nối ở trên.",
      "Chọn Connect, đăng nhập Trinity, giữ ô “Cho phép AI thay đổi dữ liệu” đã tick sẵn rồi bấm Cho phép để ChatGPT được truy cập Trinity.",
      "Mở cuộc trò chuyện mới, bật kết nối Trinity CRM và dán câu lệnh mẫu bên dưới.",
    ],
  },
  {
    title: "Claude (claude.ai / Claude Desktop)",
    steps: [
      "Vào Settings › Connectors › Add custom connector.",
      "Đặt tên Trinity CRM, dán địa chỉ kết nối ở trên, bấm Add rồi Connect.",
      "Đăng nhập Trinity, giữ ô “Cho phép AI thay đổi dữ liệu” đã tick sẵn rồi bấm Cho phép để Claude được truy cập Trinity.",
      "Trong cuộc trò chuyện, bật kết nối Trinity CRM ở menu công cụ và dán câu lệnh mẫu.",
    ],
  },
  {
    title: "Gemini (Gemini Enterprise / Gemini CLI)",
    steps: [
      "Thêm một kết nối mới trong Gemini, dán địa chỉ kết nối ở trên và chọn đăng nhập bằng tài khoản.",
      "Khi được hỏi, đăng nhập Trinity, giữ ô “Cho phép AI thay đổi dữ liệu” đã tick sẵn rồi bấm Cho phép để Gemini được truy cập Trinity.",
      "Dán câu lệnh mẫu vào cuộc trò chuyện.",
    ],
  },
]

/** Hướng dẫn kết nối Trinity vào từng AI. AI ghi dữ liệu ngay theo quyền của người dùng; xem lại ở mục Hoạt động AI. */
export function ConnectSteps() {
  return (
    <div className="space-y-2">
      {STEPS.map((s) => (
        <details key={s.title} className="rounded-[var(--radius)] border bg-card p-3 open:shadow-sm">
          <summary className="cursor-pointer text-sm font-semibold">{s.title}</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            {s.steps.map((x) => <li key={x}>{x}</li>)}
          </ol>
        </details>
      ))}
    </div>
  )
}
